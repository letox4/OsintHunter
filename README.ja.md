<div align="center">

<img src="docs/banner.svg" alt="OsintHunter" width="100%">

[🇬🇧 English](README.md) · [🇪🇸 Español](README.es.md) · **🇯🇵 日本語**

<br>

[![Release](https://img.shields.io/github/v/release/letox4/OsintHunter?style=for-the-badge&color=ff7a1a&labelColor=0d0a07&logo=github)](https://github.com/letox4/OsintHunter/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/letox4/OsintHunter/total?style=for-the-badge&color=ff7a1a&labelColor=0d0a07&logo=windows)](https://github.com/letox4/OsintHunter/releases)
[![Python](https://img.shields.io/badge/Python-3.11+-ff7a1a?style=for-the-badge&labelColor=0d0a07&logo=python&logoColor=ffb066)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-backend-ff7a1a?style=for-the-badge&labelColor=0d0a07&logo=fastapi&logoColor=ffb066)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/license-MIT-ff7a1a?style=for-the-badge&labelColor=0d0a07)](LICENSE)

[![Modules](https://img.shields.io/badge/modules-49-ffb066?style=flat-square&labelColor=1c1209)](#-モジュール)
[![Sites](https://img.shields.io/badge/username_sites-400+-ffb066?style=flat-square&labelColor=1c1209)](#-モジュール)
[![No keys](https://img.shields.io/badge/works_without_API_keys-yes-ffb066?style=flat-square&labelColor=1c1209)](#-オプションの-api-キー)
[![Languages](https://img.shields.io/badge/UI-EN%20%7C%20ES-ffb066?style=flat-square&labelColor=1c1209)](#)
[![Local](https://img.shields.io/badge/100%25-local-ffb066?style=flat-square&labelColor=1c1209)](#-プライバシー)

### ${\color{#ff7a1a}\textsf{探す。つなぐ。確かめる。}}$

ユーザー名、メールアドレス、電話番号、氏名、ドメイン、IP、またはチリの RUT から調査を始める、**デスクトップ版の OSINT プラットフォーム**です。<br>
信頼度スコア、地図、タイムライン、レポートを備えた**調査グラフ**を作り上げます。

[**⬇️ .exe をダウンロード**](https://github.com/letox4/OsintHunter/releases/latest) ·
[**🚀 クイックスタート**](#-クイックスタート) ·
[**🧩 モジュール**](#-モジュール) ·
[**📸 スクリーンショット**](#-スクリーンショット)

</div>

---

<div align="center">
<img src="docs/screenshots/en/graph.png" alt="調査グラフ" width="100%">
<sub><i>デモ用ケースのグラフです。すべてのスクリーンショットには、<b>架空の</b>人物と <code>.example</code> ドメインを使っています。</i></sub>
</div>

## ✨ 何が違うのか

${\color{#ff7a1a}\textsf{たった一つの手がかりから完全なプロフィールまで、すべてのつながりに証拠を添えて。}}$

| | |
|---|---|
| 🕸️ **ライブグラフ** | 発見したものはすべてノードになり、関係は自動で描かれます。種類、プラットフォーム、**エイリアスファミリー**ごとにバブルへまとめられます。 |
| 🎯 **信頼度スコア** | すべてのアカウントに、名前、写真、場所、相互リンクから 0〜100 のスコアを付けます。本人と**同姓同名の別人**を見分けられます。 |
| 🧬 **エイリアスファミリー** | `nyxaluna`、`nyxa.lun4`、`xnyxax` が共通の語根（リート表記、繰り返しの文字、接頭辞）を持つことを検出し、足りないバリエーションも試します。 |
| 🔁 **スマートな再試行** | Instagram、TikTok、WAF にレート制限されたときは、間隔を空けて再試行し、手作業で確認するためのチェックリストを残します。 |
| 🇨🇱 **チリの情報源** | RUT、ナンバープレート、NIC Chile、InfoProbidad、RUT による企業、大学の論文。 |
| 🗺️ **地図とタイムライン** | 場所をジオコーディングし、アカウントの作成、コミット、情報漏えい、アーカイブを時系列に並べます。 |
| 📄 **レポート** | ケースを HTML/PDF に書き出し、そのまま提出できます。 |
| 🤖 **オプションの AI** | ローカルの Ollama、または OpenAI 互換の任意のプロバイダーで、ケースの要約と分析を行います。 |
| 🔒 **完全にローカル** | 横に SQLite データベースを置く、単一の `.exe` です。情報源へのクエリ以外で、データがマシンの外に出ることはありません。 |

## 📸 スクリーンショット

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/en/confidence.png" alt="信頼度"><br><b>🎯 信頼度</b> · あるアカウントが本人である（またはない）理由</td>
    <td width="50%"><img src="docs/screenshots/en/alias.png" alt="エイリアスファミリー"><br><b>🧬 エイリアスファミリー</b> · 共通の語根と試したバリエーション</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/en/bubbles.png" alt="バブル"><br><b>🫧 バブル</b> · エイリアスファミリーごとにまとめたグラフ</td>
    <td><img src="docs/screenshots/en/map.png" alt="地図"><br><b>🗺️ 地図</b> · ジオコーディングした場所</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/en/timeline.png" alt="タイムライン"><br><b>🕒 タイムライン</b> · デジタル上の履歴を順番に</td>
    <td><img src="docs/screenshots/en/list.png" alt="リスト"><br><b>📋 リスト</b> · すべてのエンティティを、フィルター付きで</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/en/report.png" alt="レポート"><br><b>📄 レポート</b> · HTML/PDF に書き出し可能</td>
    <td><img src="docs/screenshots/en/spanish.png" alt="スペイン語の UI"><br><b>🌐 バイリンガル</b> · ワンクリックで UI がスペイン語に切り替わります</td>
  </tr>
</table>

## 🚀 クイックスタート

### 方法 1 · 実行ファイル（Windows）

1. [Releases](https://github.com/letox4/OsintHunter/releases/latest) から **`OsintHunter.exe`** をダウンロードします。
2. 任意のフォルダーに置いて実行します。ブラウザが `http://127.0.0.1:8787` で開きます。
3. 上部のバーで **English** をクリックし、ケースを作成して、ユーザー名 / メールアドレス / 電話番号 / 氏名を入力し、**Investigate** を押します。

> [!NOTE]
> データは `.exe` の隣の `data` フォルダーに保存されます。実行ファイルに署名がないため、Windows SmartScreen が警告を表示することがあります。*More info → Run anyway* を選んでください。

### 方法 2 · ソースから

```bash
git clone https://github.com/letox4/OsintHunter.git
cd OsintHunter
start.bat            # creates the venv, installs dependencies and starts
```

Linux / macOS の場合：

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app
```

### 自分で .exe をビルドする

```bash
build_exe.bat        # output goes to dist\OsintHunter.exe
```

## 🧩 モジュール

<details open>
<summary>データの種類ごとに整理された <b>49 のモジュール</b></summary>

<br>

| 入力 | モジュール |
|---|---|
| 👤 **ユーザー名** | 詳細なプロフィール（Instagram、TikTok、GitHub、Reddit…）、**400 以上のサイト**（Sherlock データベース）の一斉検索、エイリアスのバリエーションとファミリー、ブロック検出時の再試行、GitHub の詳細調査、Wayback にアーカイブされたプロフィール、フォーラムでの言及、プロフィールページリーダー |
| 📧 **メールアドレス** | MX の検証、Gravatar、情報漏えい（XposedOrNot、HIBP）、アプリに登録されたアカウント、Hunter.io |
| 📱 **電話番号** | キャリア、国、回線の種類、Numverify |
| 🧑 **人物** | ウェブ検索（DuckDuckGo、Bing、Serper、Brave）、dork、Wikidata、学術論文 |
| 🌐 **ドメイン / URL** | DNS、RDAP/WHOIS、サブドメイン（crt.sh）、ウェブサイトの分析、Wayback、VirusTotal、URLScan、URLhaus |
| 🖥️ **IP** | ジオロケーション、Shodan InternetDB、逆引き DNS、Shodan、AbuseIPDB、GreyNoise |
| 🇨🇱 **チリ** | RUT、ナンバープレート、NIC Chile、InfoProbidad / ロビー活動、RUT による企業、論文 |
| 📎 **その他** | ドキュメントと画像のメタデータ（EXIF/GPS）、ハッシュ、MalwareBazaar、暗号資産ウォレット、Discord の招待、Flickr のジオ情報 |

</details>

## 🔑 オプションの API キー

OsintHunter は**キーがなくても動作します**。*Settings* にいくつか追加すると、より多くの情報源が使えるようになります。

<details>
<summary>13 の連携を見る</summary>

<br>

| サービス | 用途 |
|---|---|
| Serper.dev / Brave Search | より信頼性の高いウェブ検索（Google） |
| GitHub トークン | 上限を 1 時間あたり 60 リクエストから 5000 リクエストに引き上げます |
| Have I Been Pwned | メールアドレスの情報漏えい |
| Hunter.io | メールアドレスの検証 |
| Numverify | 電話番号のデータ |
| Shodan · AbuseIPDB · GreyNoise | IP の評判 |
| VirusTotal · URLScan · abuse.ch | ドメインと URL の評判 |
| AI プロバイダー | AI による分析（ローカルの Ollama では不要） |

</details>

## 🔒 プライバシー

- すべて**あなたのマシン**（`127.0.0.1`）で動作します。中継サーバーもテレメトリもありません。
- ケース、設定、キーは `data/` に保存され、これはリポジトリから除外されています。

## ⚖️ 責任ある利用

> [!WARNING]
> OsintHunter が問い合わせるのは**公開されている情報源**だけです。サイバーセキュリティ、ジャーナリズム、本人確認、行方不明者の捜索、自分自身のデジタルフットプリントの監査といった、正当な調査のために作られています。
> **嫌がらせ、ストーキング、他人のプライバシーの侵害には使わないでください。** お住まいの国のデータ保護法と、各サービスの利用規約に従ってください。悪用について、作者は責任を負いません。

---

<div align="center">

### ${\color{#ff7a1a}\textsf{制作：letox4}}$

役に立ったら、⭐ を残してください。とても励みになります。

<sub>MIT © 2026 letox4</sub>

</div>
