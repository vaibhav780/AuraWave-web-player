# AuraWave App Update Server

A small, portable server that pushes **app updates** to the AuraWave Android app.
Copy this whole folder (with an APK inside) to any machine, run it, and update
phones over Wi-Fi by scanning a QR — no app store, no cable.

---

## Two situations (the server shows a QR for each)

When it starts, the server prints **two** QR codes (also at the `/qr` web page):

### A. First install — app not on the phone yet
You can't scan "inside the app" before the app exists, so for the first install:

- **Scan the "FIRST INSTALL" QR with your phone's normal camera.** It opens the
  browser and downloads the APK; tap the downloaded file to install.
- Or open **`http://<pc-ip>:9696/update.apk`** in the phone's browser.
- Or install over USB from the project: `gradlew.bat installDebug`
  (or Android Studio ▶ Run), or `deploy_to_phone.bat`.

The first time, Android asks to allow **"Install unknown apps"** for your browser
— allow it, then the install proceeds.

### B. Later updates — app already installed
1. Put a newer APK in this folder (see below) and run the server.
2. In **AuraWave**, tap the **"Check for App Update"** icon (⟳ in the top bar)
   and scan the **"IN-APP UPDATE"** QR.
3. If the APK here is newer than the installed build, the app downloads it and
   launches the installer. Approve the prompt and you're updated.

> The app compares the APK's **modification time** against the installed build's
> install time, so a freshly built/copied APK always registers as "newer".

---

## Where to put the APK

Drop it directly in this folder:

```
update-server/
├── update_server.py
├── run_update_server.bat
├── app-debug.apk        <-- put your APK here (any *.apk works)
└── release_notes.txt    <-- optional; its text shows in the update dialog
```

An `./apk/` subfolder also works. If several APKs are present, the **newest**
(by modification time) is served.

### Getting a fresh APK from the project
From the Android project build the debug APK:

```
gradlew.bat assembleDebug
```

It is written to `app/build/outputs/apk/debug/app-debug.apk`. The project's
Gradle build **auto-copies** that APK into this folder after every
`assembleDebug` (see the `copyApkToUpdateServer` task), so on the build machine
this folder stays up to date automatically. To ship to another machine, just
copy this whole folder (APK included).

---

## Endpoints

| Method | Endpoint | Description |
|-------|----------|-------------|
| `GET` | `/` | Status page |
| `GET` | `/update.json` · `/version.json` | Update metadata the app reads |
| `GET` | `/update.apk` · `/app-debug.apk` | Downloads the APK |
| `GET` | `/qr` | Web page with the connect QR |
| `GET` | `/health` | `{"status":"ok"}` |

Default port: **9696** (change with `--port`). Bind address: `0.0.0.0`.

Example `/update.json`:

```json
{
  "versionCode": 1760000000,
  "versionName": "1.0.0-build1760000000",
  "apkUrl": "http://192.168.1.15:9696/update.apk",
  "fileSizeBytes": 44783385,
  "releaseNotes": "Latest AuraWave build served from your local update server."
}
```

---

## Requirements & notes

- **Python 3.8+** (standard library only). The launcher also tries to install
  the optional `qrcode` package so a QR is drawn in the terminal; if that fails,
  use the `/qr` web page instead.
- The phone must allow installing from this source (**Install unknown apps**).
  The app routes you to that setting automatically the first time.
- PC and phone must be on the **same Wi-Fi**, and Windows Firewall must allow
  Python on private networks (allow it when prompted).
- This is separate from the music **streaming** server — you can run both at
  once (they use different ports: streaming 9595, updates 9696).
