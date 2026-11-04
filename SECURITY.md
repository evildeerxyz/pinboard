# Security

## Reporting a problem

If you find a security problem in Pinboard, please report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Please don't open a public issue for it.

Say what you found, how to reproduce it, and which version of Pinboard and macOS you used. You'll get a reply as soon as possible, and a fix will go out in a new release.

## What Pinboard can touch

Pinboard runs on your Mac with your user's permissions. It isn't sandboxed, because it has to see pictures anywhere in your home folder. To keep that safe:

- It makes no network requests. The window can't load anything from the internet (see the content security policy in `src-tauri/tauri.conf.json`), can't go to any page but Pinboard's own, and only has the few window permissions it uses (`src-tauri/capabilities/default.json`).
- The window can only refer to pictures by the ids Pinboard gave them when it indexed your home folder. It can't name an arbitrary file to open, move or read, and Show in Finder only shows folders that hold pictures, without opening them.
- Only files with picture extensions are ever listed, so nothing in Pinboard can open an app or a script, whatever its name.
- The only change it makes to your files is moving pictures you select to the Trash. Undo can only put back pictures Pinboard itself moved, to the place they came from.
- Pictures are never decoded inside Pinboard. Thumbnails are made by Quick Look in macOS's own sandboxed thumbnail service, so a malformed or malicious image can't run code with Pinboard's access to your folders. Pinboard only encodes the finished thumbnail, and keeps it in `~/Library/Caches/app.pinboard.photos`. Pictures over 250 megapixels are skipped.

## Releases

Releases are built with `npm run release` and signed ad hoc, not yet with an Apple Developer ID, so macOS asks you to confirm the first time you open the app. Each release lists the SHA-256 of its DMG; you can check your download with:

```sh
shasum -a 256 ~/Downloads/Pinboard-*.dmg
```
