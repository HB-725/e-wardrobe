# Web screenshots

UI check without a device: export the web build, serve it with the demo images, screenshot with Playwright.

```bash
cd app && npx expo export --platform web
node scripts/web-shots/serve.js dist scripts/web-shots/demo &   # http://localhost:8090
mkdir -p /tmp/shots && node scripts/web-shots/shoot.js /tmp/shots
```

`?demo=1` seeds a full wardrobe (`src/dev/seedDemo.ts`), `?demo=empty` a fresh install, `?demo=noavatar` no avatar.
The images in `demo/` are AI-generated samples (no real person).

`VW` / `VH` set the viewport (default 390×844) and `DPR` the pixel ratio (default 2). Store screenshots (9:16, 1080×1920):
`VW=360 VH=640 DPR=3 node scripts/web-shots/shoot.js /tmp/store`.
