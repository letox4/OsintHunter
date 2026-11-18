import base64
import ctypes
from ctypes import wintypes
import json
import logging
import os
import shutil
import sys
import threading
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("osint")

if getattr(sys, "frozen", False):
    # ejecutable de PyInstaller: los ficheros empaquetados están en _MEIPASS y los datos junto al .exe
    BUNDLE = Path(sys._MEIPASS)
    ROOT = Path(sys.executable).resolve().parent
    WEB_DIR = BUNDLE / "web"
    RESOURCES_DIR = BUNDLE / "app" / "resources"
else:
    ROOT = Path(__file__).resolve().parent.parent
    WEB_DIR = ROOT / "web"
    RESOURCES_DIR = Path(__file__).resolve().parent / "resources"


def _data_dir() -> Path:
    env_dir = os.environ.get("OSINT_DATA_DIR")
    candidates = [Path(env_dir)] if env_dir else [
        ROOT / "data",
        Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "OsintHunter" / "data",
    ]
    for d in candidates:
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / ".write-test"
            probe.write_text("ok")
            probe.unlink()
            return d
        except OSError:
            continue
    raise RuntimeError("No hay ninguna carpeta con permiso de escritura para guardar los datos")


DATA_DIR = _data_dir()

SETTINGS_FILE = DATA_DIR / "settings.json"
KEYRING_SERVICE = os.environ.get("OSINT_KEYRING_SERVICE", "OsintHunter")

# clave -> (nombre visible, dónde conseguirla)
API_KEYS: dict[str, tuple[str, str]] = {
    "shodan": ("Shodan", "https://account.shodan.io/"),
    "virustotal": ("VirusTotal", "https://www.virustotal.com/gui/my-apikey"),
    "hunter": ("Hunter.io", "https://hunter.io/api-keys"),
    "abuseipdb": ("AbuseIPDB", "https://www.abuseipdb.com/account/api"),
    "abusech": ("abuse.ch Auth-Key (URLhaus, ThreatFox, MalwareBazaar)", "https://auth.abuse.ch/"),
    "urlscan": ("URLScan.io", "https://urlscan.io/user/profile/"),
    "greynoise": ("GreyNoise Community", "https://viz.greynoise.io/account/api-key"),
    "github": ("GitHub token (sube el límite de 60 a 5000 peticiones/h)", "https://github.com/settings/tokens"),
    "numverify": ("Numverify", "https://numverify.com/product"),
    "hibp": ("Have I Been Pwned (de pago)", "https://haveibeenpwned.com/API/Key"),
    "serper": ("Serper.dev (Google; 2500 búsquedas gratis, mejora la búsqueda de personas)", "https://serper.dev/api-key"),
    "brave": ("Brave Search API (alternativa a Serper)", "https://api-dashboard.search.brave.com/app/keys"),
    "ai": ("Clave del proveedor de IA (no hace falta con Ollama local)", "https://console.groq.com/keys"),
}

DEFAULT_SETTINGS = {
    "api_keys": {},
    "ai_base_url": "",
    "ai_model": "",
    "default_region": "",
    "sherlock_db": True,
    "include_nsfw": False,
    "username_timeout": 15,
    "max_pivot_entities": 25,
    "lang": "es",
}


# ---------- Cifrado DPAPI (fallback en Windows cuando keyring no está disponible) ----------

class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi_available() -> bool:
    return sys.platform == "win32" and hasattr(ctypes, "windll") and hasattr(ctypes.windll, "crypt32")


def _dpapi_encrypt(plaintext: str) -> str | None:
    if not _dpapi_available():
        return None
    try:
        raw = plaintext.encode("utf-8")
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DATA_BLOB()
        crypt32 = ctypes.windll.crypt32
        crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DATA_BLOB), wintypes.LPCWSTR, ctypes.POINTER(_DATA_BLOB),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DATA_BLOB),
        ]
        crypt32.CryptProtectData.restype = wintypes.BOOL
        if not crypt32.CryptProtectData(ctypes.byref(blob_in), "OsintHunter", None, None, None, 0x01, ctypes.byref(blob_out)):
            return None
        try:
            enc = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            return "dpapi:" + base64.b64encode(enc).decode("ascii")
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:  # noqa: BLE001
        return None


def _dpapi_decrypt(token: str) -> str | None:
    if not token.startswith("dpapi:") or not _dpapi_available():
        return None
    try:
        raw = base64.b64decode(token[6:])
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DATA_BLOB()
        crypt32 = ctypes.windll.crypt32
        crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DATA_BLOB), ctypes.c_void_p, ctypes.POINTER(_DATA_BLOB),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DATA_BLOB),
        ]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0x01, ctypes.byref(blob_out)):
            return None
        try:
            dec = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            return dec.decode("utf-8")
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:  # noqa: BLE001
        return None


# ---------- Keyring (Windows Credential Manager / SecretService / macOS Keychain) ----------

def _init_keyring():
    if os.environ.get("OSINT_DISABLE_KEYRING") == "1":
        return None
    try:
        import keyring
        kr = keyring.get_keyring()
        mod_name = type(kr).__module__.lower()
        if ("fail" in mod_name or "null" in mod_name) and sys.platform == "win32":
            from keyring.backends.Windows import WinVaultKeyring
            kr = WinVaultKeyring()
            keyring.set_keyring(kr)
            mod_name = type(kr).__module__.lower()
        if "fail" in mod_name or "null" in mod_name:
            return None
        return keyring
    except Exception:  # noqa: BLE001
        return None


class Settings:
    def __init__(self, path: Path = SETTINGS_FILE, service: str = KEYRING_SERVICE):
        self.path = path
        self.service = service
        self._lock = threading.Lock()
        self._keyring = _init_keyring()
        self.data = dict(DEFAULT_SETTINGS)
        self._keys: dict[str, str] = {}
        self.storage_backend = "keyring" if self._keyring else ("dpapi" if _dpapi_available() else "json")

        disk_data: dict = {}
        if path.exists():
            try:
                disk_data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(disk_data, dict):
                    for k, v in disk_data.items():
                        if k in DEFAULT_SETTINGS and k != "api_keys":
                            self.data[k] = v
            except (OSError, ValueError):
                disk_data = {}

        # 1. Cargar claves desde keyring si está disponible
        if self._keyring:
            for k in API_KEYS:
                try:
                    val = self._keyring.get_password(self.service, k)
                    if val:
                        self._keys[k] = val
                except Exception:  # noqa: BLE001
                    pass

        # 2. Procesar claves en settings.json (migración desde texto plano o lectura de DPAPI/fallback)
        raw_keys = disk_data.get("api_keys") if isinstance(disk_data.get("api_keys"), dict) else {}
        needs_migration_save = False
        has_plaintext_on_disk = False

        for k, raw_val in raw_keys.items():
            if k not in API_KEYS or not isinstance(raw_val, str) or not raw_val.strip():
                continue
            raw_val = raw_val.strip()
            if raw_val.startswith("dpapi:"):
                dec = _dpapi_decrypt(raw_val)
                if dec:
                    if self._keyring:
                        # Migrar de DPAPI a keyring
                        if self._store_in_keyring(k, dec):
                            self._keys[k] = dec
                            needs_migration_save = True
                        else:
                            self._keys[k] = dec
                    else:
                        self._keys[k] = dec
            else:
                has_plaintext_on_disk = True
                self._keys[k] = raw_val
                if self._keyring or _dpapi_available():
                    needs_migration_save = True

        if has_plaintext_on_disk and needs_migration_save:
            self._backup_and_migrate()
        elif needs_migration_save:
            self._write_disk()
        elif self.storage_backend == "json" and has_plaintext_on_disk:
            log.warning("Ni keyring ni DPAPI están disponibles; las claves API permanecen en texto plano en %s", self.path)

        self.data["api_keys"] = dict(self._keys)

    def _store_in_keyring(self, k: str, v: str) -> bool:
        if not self._keyring:
            return False
        try:
            if v:
                self._keyring.set_password(self.service, k, v)
            else:
                try:
                    self._keyring.delete_password(self.service, k)
                except Exception:  # noqa: BLE001
                    pass
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("No se pudo guardar la clave '%s' en keyring (%s), usando fallback.", k, e)
            return False

    def _backup_and_migrate(self) -> None:
        if self.path.exists():
            bak = self.path.with_name(self.path.name + ".bak")
            try:
                shutil.copy2(self.path, bak)
            except OSError as e:
                log.warning("No se pudo crear copia de respaldo %s: %s", bak, e)
        for k, v in list(self._keys.items()):
            if self._keyring:
                self._store_in_keyring(k, v)
        self._write_disk()

    def _serialize_keys_for_disk(self) -> dict[str, str]:
        if self._keyring:
            # Con keyring activo, no guardamos ninguna clave en settings.json
            return {}
        if _dpapi_available():
            out = {}
            for k, v in self._keys.items():
                if v:
                    enc = _dpapi_encrypt(v)
                    if enc:
                        out[k] = enc
                    else:
                        log.warning("Fallo al cifrar la clave '%s' con DPAPI; se guardará en JSON.", k)
                        out[k] = v
            return out
        log.warning("Guardando claves API en texto plano en %s (keyring y DPAPI no disponibles)", self.path)
        return dict(self._keys)

    def _write_disk(self) -> None:
        payload = {k: v for k, v in self.data.items() if k != "api_keys"}
        payload["api_keys"] = self._serialize_keys_for_disk()
        self.path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self, name: str, default=None):
        return self.data.get(name, default)

    def key(self, name: str) -> str | None:
        return self._keys.get(name) or None

    def update(self, changes: dict) -> None:
        changes = dict(changes)
        if "ai_base_url" in changes:
            val = (changes["ai_base_url"] or "").strip() if isinstance(changes["ai_base_url"], str) else ""
            if val:
                parsed = urlparse(val)
                if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc or any(c.isspace() for c in val):
                    raise ValueError("URL base de IA no válida: solo se permiten esquemas http o https")
            changes["ai_base_url"] = val

        with self._lock:
            for k, v in (changes.pop("api_keys", None) or {}).items():
                if k not in API_KEYS:
                    continue
                v = (v or "").strip()
                if v:
                    self._keys[k] = v
                    if self._keyring and not self._store_in_keyring(k, v):
                        self._keyring = None
                        self.storage_backend = "dpapi" if _dpapi_available() else "json"
                else:
                    self._keys.pop(k, None)
                    if self._keyring:
                        self._store_in_keyring(k, "")
            self.data["api_keys"] = dict(self._keys)
            for k, v in changes.items():
                if k in DEFAULT_SETTINGS and k != "api_keys":
                    self.data[k] = v
            self._write_disk()

    def public(self) -> dict:
        keys = self._keys
        out = {k: v for k, v in self.data.items() if k != "api_keys"}
        out["api_keys"] = {
            k: {
                "label": label,
                "url": url,
                "set": bool(keys.get(k)),
                "masked": (keys[k][:3] + "…" + keys[k][-3:]) if len(keys.get(k) or "") > 8 else ("•••" if keys.get(k) else ""),
            }
            for k, (label, url) in API_KEYS.items()
        }
        return out


settings = Settings()
