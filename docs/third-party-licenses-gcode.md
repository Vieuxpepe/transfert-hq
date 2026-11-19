# Licences tierces — Visualiseur G-code 3D (Atelier 3D)

Les fichiers pré-assemblés suivants sont hébergés localement dans `assets/` sans aucun CDN externe ni télémétrie :

- `assets/vendor-gcode-preview.mjs`
- `assets/vendor-gcode-worker.js`
- `assets/vendor-gcode-geo-worker.js`

Source de build reproductible : `tools/gcode_vendor/` (`package.json`, `build.mjs`, `entry-viewer.mjs`, `entry-parse-worker.mjs`).

## Dépendances épinglées

| Paquet | Version épinglée | Licence | Auteur |
|--------|------------------|---------|--------|
| `@chestnutlabs/gcode-preview-element` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-preview-core` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-parser` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-dialects` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-colors` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-renderer-three` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-renderer-2d` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-containers` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-bgcode` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/gcode-model-renderer` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `@chestnutlabs/toolpath-core` | `0.24.0` | MIT | Chestnut Labs / Remco Veldkamp |
| `three` | `0.178.0` | MIT | three.js authors |

## Textes de licence

### Chestnut Labs / gcode-preview (MIT)

```text
MIT License

Copyright (c) 2017-2025 Remco Veldkamp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### three.js (MIT)

```text
The MIT License

Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
