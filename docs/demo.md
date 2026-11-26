# Demo pública de NetLab (Fase 8 T5)

La UI de NetLab es un build estático de `packages/web`: SvelteKit con
`@sveltejs/adapter-static` y prerender total (`prerender = true` en
`src/routes/+layout.ts`), con `fallback: "404.html"` para los deep links
que un host estático no resuelve. La simulación corre en un Web
Worker (`src/lib/sim.worker.ts`). No hay backend ni WebSocket: cualquier
hosting de archivos sirve la demo tal cual.

## Build

```sh
cd packages/web
bun run build                     # sitio en la raíz (default de siempre)
BASE_PATH=/Net-Lab/ bun run build # sitio servido desde /Net-Lab/
```

- `BASE_PATH` sin setear, vacío o `/` = raíz. El default no cambió.
- Acepta con o sin barra final; se normaliza a `""` o `/algo`
  (`packages/web/vite.config.ts`, plugin `sveltekit({ paths })`).
- Salida en `packages/web/build/`: `index.html`, `workbench.html`,
  `teoria.html`, `practica.html`, `editor.html`, `404.html`, `_app/` y el
  worker en `_app/immutable/workers/sim.worker-<hash>.js`. `index.html` es
  la landing (`/`), el workbench vive en `/workbench` y la teoría en
  `/teoria`.
- `404.html` es el fallback SPA que genera `adapter-static`
  (`fallback: "404.html"` en `packages/web/vite.config.ts`): un shell
  vacío que arranca el router del cliente y resuelve la ruta pedida. Las
  cinco rutas se siguen prerenderizando a su propio HTML; el fallback
  solo cubre los deep links que un host estático no sabe mapear (es la
  recomendación de GitHub Pages). Con `BASE_PATH` el fallback también
  queda prefijado (`/Net-Lab/_app/…`, `base: "/Net-Lab"`).
- Ojo: pasar `fallback` desactiva el chequeo de rutas dinámicas de
  `adapter-static` (la garantía de prerender total la da el smoke de
  `pages.yml`, que exige los cinco HTML).
- El host de dev no cambia: esto es solo build/preview.

**Windows + Git Bash:** MSYS reescribe los valores de entorno que
empiezan con `/` antes de lanzar el proceso, así que
`BASE_PATH=/Net-Lab/` llega como `C:/…/Net-Lab/` y el build hornea un
base inválido. Excluilo:

```sh
MSYS2_ENV_CONV_EXCL=BASE_PATH BASE_PATH=/Net-Lab/ bun run build
```

o usá PowerShell:

```powershell
$env:BASE_PATH = "/Net-Lab/"
bun run build
```

## Verificación local (sin prefijo)

```sh
cd packages/web
bun run build
bun run preview   # http://127.0.0.1:4173
```

`/`, `/workbench`, `/teoria`, `/practica` y `/editor` responden 200 (y
también `workbench.html`, `teoria.html` y `practica.html` sin depender
del mapeo sin extensión). El artefacto tiene que traer además el
fallback SPA (el `.nojekyll` no lo escribe el build, lo crea el smoke de
`pages.yml`):

```sh
for page in index workbench teoria practica editor 404; do
  test -f "build/$page.html"
done
echo "artefacto ok: $(find build -type f | wc -l) archivos"
```

Alternativa con el binario, que sirve
`packages/web/build` desde disco y no necesita el preview de Vite:

```sh
bun packages/cli/src/main.ts serve --port 8080
# netlab listo en http://127.0.0.1:8080/
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/workbench  # 200
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/teoria     # 200
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/practica  # 200
```

`vite preview` **no respeta `BASE_PATH`**: SvelteKit descarta el base
middleware en preview y `/Net-Lab/` responde 404. El build con prefijo
se verifica con un server estático montado en `/Net-Lab/` que mapee
`/practica` → `practica.html` (por ejemplo `try_files $uri $uri.html` en
nginx), o directamente en el deploy.

> **Nota:** `packages/web/build/` no se commitea (está en
> `.gitignore`) y `packages/cli/src/manifest.gen.ts` se genera desde
> ese build (`bun packages/cli/scripts/gen-manifest.ts`, o vía el
> script `compile` del CLI) cada vez que se arma el binario con la UI
> embebida. Si cambiás la web y vas a distribuir el binario,
> regenerá el manifest antes de compilar.

Worker: en DevTools → Network, recargar y confirmar
`sim.worker-<hash>.js` con 200 y sin requests a otro origen; el trabajo
de simulación aparece en el perfil fuera del hilo principal. El chunk se
resuelve relativo al módulo (`new URL("../workers/…", import.meta.url)`),
así que el prefijo no lo afecta.

## GitHub Pages

`.github/workflows/pages.yml` construye y publica el sitio con la receta
oficial de Pages (job `build` + job `deploy`):

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
   Es un paso previo obligatorio: `actions/configure-pages` lee la
   configuración del sitio, y sin Pages habilitado el job falla.
2. Push a `main` (o _Run workflow_ manual).
3. URL: `https://<owner>.github.io/<repo>/`.

El prefijo ya no lo calcula el workflow: lo aporta GitHub Pages vía
`actions/configure-pages@v5`, que publica `base_path` (`/Net-Lab` en un
project site, vacío en `<owner>.github.io` o con dominio propio). Ese
valor entra como `BASE_PATH` al build; `vite.config.ts` normaliza ambos
casos, así que no hay nombres de repo hardcodeados.

Orden de los pasos del job `build`: `checkout`, `setup-bun` (1.4.5,
igual que `ci.yml`), `configure-pages` (`id: pages`), `bun install`,
build con `BASE_PATH=${{ steps.pages.outputs.base_path }}` y
`working-directory: packages/web`, smoke del artefacto, y
`upload-pages-artifact` con `include-hidden-files: true` (porque
`.nojekyll` es un archivo oculto y el artefacto los ignora por default;
lo crea el propio smoke). El job `deploy` solo depende de `build`, corre
en el environment `github-pages` y ejecuta `deploy-pages`.

El smoke chequea los cinco HTML prerenderizados (`index`, `workbench`,
`teoria`, `practica`, `editor`), el fallback `404.html` y el chunk del
worker. Esa lista es la puerta que garantiza el prerender total, porque
`adapter-static` desactiva su chequeo de rutas dinámicas cuando hay
`fallback`. Permisos (`contents: read`, `pages: write`,
`id-token: write`) y `concurrency` (grupo `pages`, sin cancelar el
deploy en curso) quedan como estaban. `ci.yml` no se toca.

El workflow no se ejecutó en este entorno (no hay remoto ni
credenciales): el deploy real queda por verificar en el primer push a
`main`.

## Cualquier otro hosting estático

Subí el contenido de `packages/web/build` tal cual. Si el sitio vive en
un subpath, buildear con `BASE_PATH` igual al prefijo. El server tiene
que resolver rutas sin extensión (`/practica` → `practica.html`) y
servir `text/javascript` para `.js`; el `.nojekyll` es solo defensivo
para Pages. Si el host no mapea extensiones, configurá un fallback
hacia `404.html` (como hace Pages) o pedí `/practica.html`.

## Limitaciones conocidas

1. **Subpath y assets — resuelto por `BASE_PATH`.** Los HTML
   prerenderizados referencian `_app` de forma relativa y el cliente
   hornea `base`, así que `/Net-Lab/`, `/Net-Lab/workbench`,
   `/Net-Lab/teoria`, `/Net-Lab/practica` y el worker cargan sin ajustes
   extra. Verificado con el build `BASE_PATH=/Net-Lab/` servido bajo ese
   prefijo.
2. **Enlaces de navegación con `resolve`.** Los `href` internos usan
   `resolve()` de `$app/paths` (`href={resolve("/workbench")}`,
   `href={resolve("/editor")}`), que antepone `base` en runtime, así que
   funcionan igual en raíz y bajo subpath. Con `base` vacío el HTML
   resultante es el mismo de siempre (`/workbench`, `/editor`).
3. **Rutas planas.** El adaptador escribe `practica.html`, no
   `practica/index.html` (igual con `workbench.html` y `teoria.html`); un
   server sin fallback `.html` devuelve 404 al refrescar `/practica`,
   `/workbench` o `/teoria`. `netlab serve` ya lo maneja y Pages cae en
   `404.html`, que arranca el router del cliente; en otros hosts, mapeá
   la extensión, configurá el fallback o pedí `/practica.html`.
4. **Sin backend.** No hay `netlab serve` remoto ni WebSocket: importar
   escenarios, exportar pcap y correr la simulación pasan en el
   cliente.
