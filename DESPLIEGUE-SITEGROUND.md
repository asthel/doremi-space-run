# Cómo instalar el ranking público en SiteGround

Guía paso a paso para poner en línea el **servidor del ranking** de Doremi Space Run (la carpeta `server/`) en SiteGround, con la opción "Node.js Projects".

**Antes de empezar, ten en cuenta:**
- Esta guía es solo para el **servidor del ranking**. El juego (`index.html`) se publica aparte.
- Todo lo que aparece así: **[por confirmar]** son cosas de SiteGround que **no se han verificado**: nombres de botones o campos, límites, comportamiento. Cuando llegues a esa parte, revisa lo que ves en tu pantalla o pregúntale al soporte de SiteGround. No lo tomes como dato seguro.
- Nada de esto se ha instalado todavía. El clic final lo das tú.

---

## 0. Palabras que vas a ver

| Palabra | Qué significa |
|---|---|
| **Servidor** o **app** | El programa `server.js`. Guarda los puntajes y responde al juego. |
| **Variable de entorno** | Un dato de configuración que se escribe en el panel de SiteGround, no en un archivo. Por ejemplo, la clave de administración. Es como una nota pegada por fuera de una caja: la app la lee al arrancar, pero no queda guardada dentro de los archivos. |
| **Carpeta de datos** (`DATA_DIR`) | La carpeta donde la app guarda el archivo `scores.json`. Ese archivo tiene los puntajes, los nombres bloqueados y los PIN de los nombres reservados (cifrados). |
| **Proxy** | Un intermediario de SiteGround que recibe las visitas antes que tu app. **[por confirmar]** si SiteGround usa uno delante de las apps Node.js. |
| **Log** o **registro** | El texto que la app escribe mientras funciona. Ahí ves si arrancó bien. |

---

## 1. Lo que necesitas tener listo

1. Acceso a **Site Tools** de SiteGround con permiso para crear proyectos Node.js. **[por confirmar]** si tu plan incluye "Node.js Projects".
2. La **dirección web** donde va a vivir el ranking. Por ejemplo, un subdominio como `https://[ranking.tu-dominio.com]`. **[por confirmar]** cómo asigna SiteGround una dirección a un proyecto Node.js.
3. La **dirección exacta del juego**, para la variable `ALLOWED_ORIGIN`. Por ejemplo `https://[bakkufest.com]`, todavía por decidir.
4. Una **clave de administración** (`ADMIN_KEY`) de **16 caracteres o más**. Cómo crearla:
   - **Desde el teléfono o cualquier equipo:** usa el generador de contraseñas de tu gestor de contraseñas (por ejemplo, el de tu teléfono). Pide 24 caracteres o más.
   - **Desde una computadora con Node instalado:**

     ```bash
     node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
     ```

   Guárdala en tu gestor de contraseñas. Compártela con Dex por un canal privado. **Nunca** la escribas en un archivo del proyecto ni en GitHub.

---

## 2. Qué archivos subir

Sube **solo** estos 4 archivos de la carpeta `server/`:

| Archivo | Para qué sirve |
|---|---|
| `server.js` | El programa principal (el archivo de inicio). |
| `admin.html` | La página de moderación (`/admin`). |
| `blocklist.json` | La lista de palabras prohibidas en los nombres. |
| `package.json` | La descripción de la app. No tiene dependencias: no hace falta "npm install". |

**No subas:**
- la carpeta `server/data/` (son datos de prueba de tu computadora, si existe);
- la carpeta `server/test/` (son pruebas; no hacen falta en línea);
- ningún archivo que contenga la clave.

**Dónde subirlos:** en la carpeta del proyecto Node.js. **[por confirmar]** qué carpeta crea o pide SiteGround. Normalmente se usa el Administrador de archivos (File Manager) de Site Tools o una conexión SFTP.

> Consejo: antes de subir una versión nueva, **descarga un .zip de la versión que ya está en línea** y nómbralo con la fecha. Ese .zip es tu "botón de regreso" (ver la sección 9).

---

## 3. Crear el proyecto Node.js

En Site Tools, entra a la sección de Node.js. **[por confirmar]** el nombre exacto del menú.

Llena los campos así. **[por confirmar]** el nombre exacto de cada campo:

| Lo que te pide | Qué escribir |
|---|---|
| Versión de Node.js | **18 o más nueva**. Si hay varias, elige la más reciente marcada como estable o LTS. |
| Carpeta de la app | La carpeta donde subiste los 4 archivos. |
| Archivo de inicio (startup file) | `server.js` |
| Comando de inicio (si lo pide) | `node server.js` o `npm start`. Los dos hacen lo mismo. **[por confirmar]** cuál de los dos acepta SiteGround. |
| Puerto | **No escribas uno inventado.** La app usa el puerto que SiteGround le dé en la variable `PORT`. **[por confirmar]** si SiteGround la pone solo o si tú tienes que escribirla. Si tienes que escribirla, usa el número que SiteGround te indique. |

---

## 4. Las variables de entorno

Busca dónde se agregan "variables de entorno" (environment variables) en el proyecto Node.js. **[por confirmar]** si SiteGround tiene esa opción en el panel. Si no la ves, pregúntale al soporte: *"¿Cómo le paso variables de entorno a mi app Node.js?"*. **No** escribas la clave dentro de `server.js` como solución.

Agrega estas 4 (y `PORT` solo si SiteGround te la pide):

| Nombre (tal cual, en mayúsculas) | Qué escribir | Ejemplo |
|---|---|---|
| `ADMIN_KEY` | Tu clave de administración, de 16 caracteres o más. | *(la tuya, nunca la compartas en público)* |
| `ALLOWED_ORIGIN` | La dirección del juego, con `https://` y **sin** `/` al final. Si son varias, sepáralas con coma. | `https://[bakkufest.com]` |
| `DATA_DIR` | Una carpeta **fuera** de la carpeta pública del sitio, donde la app pueda escribir. | `/home/[tu-usuario]/dsr-data` **[por confirmar la ruta real en SiteGround]** |
| `TRUST_PROXY` | **Déjala apagada al principio**: no la pongas, o escribe `0`. Lee el paso 7 antes de cambiarla. | `0` |

Detalles importantes:
- **`DATA_DIR`:** si la carpeta no existe, la app la crea. Si la app **no puede escribir** ahí, no arranca y muestra un mensaje claro (ver el paso 5). Ese es el aviso para cambiar la ruta.
- **¿Los datos sobreviven a un reinicio o a una actualización?** **[por confirmar]**. Si SiteGround borra o reemplaza la carpeta del proyecto cuando actualizas, **los puntajes se perderían**. Por eso conviene que `DATA_DIR` esté **fuera** de la carpeta de la app, y que hagas respaldos (sección 8).
- Si escribes mal `ALLOWED_ORIGIN`, el ranking se ve en el juego pero **no se pueden guardar puntajes**. El juego guarda en el teléfono del jugador como respaldo.

---

## 5. Arrancar la app

1. Pulsa el botón para iniciar o reiniciar el proyecto. **[por confirmar]** el nombre del botón.
2. Abre el **registro** (log) de la app. **[por confirmar]** dónde lo muestra SiteGround.
3. Debes ver **una sola línea** parecida a esta:

   ```
   [dsr] started: PORT=12345 DATA_DIR=/home/[tu-usuario]/dsr-data TRUST_PROXY=off ALLOWED_ORIGIN=https://[bakkufest.com] ADMIN=enabled
   ```

   Revisa tres cosas:
   - `DATA_DIR=` muestra la carpeta que elegiste.
   - `ADMIN=enabled`. Si dice `disabled`, falta `ADMIN_KEY`. Si dice `DISABLED (ADMIN_KEY shorter than 16 characters)`, la clave es muy corta.
   - La clave **nunca** aparece en el registro. Si alguna vez la ves ahí, avísame.

**Si en vez de eso ves un error:**

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| `cannot write to DATA_DIR "..." (EACCES)` | La app no tiene permiso para escribir en esa carpeta. | Elige otra ruta para `DATA_DIR`, por ejemplo una dentro de tu carpeta de usuario, o pídele al soporte el permiso de escritura. |
| `cannot write to DATA_DIR "..." (ENOTDIR)` o `(EEXIST)` | La ruta apunta a un archivo, no a una carpeta. | Corrige la ruta. |
| `cannot listen on PORT ... (EADDRINUSE)` | Ese puerto ya lo usa otra cosa. | Usa el puerto que SiteGround te asigne, o deja que lo ponga solo. |

---

## 6. Comprobar que funciona

Abre estas direcciones en el navegador del teléfono. Cambia `[ranking.tu-dominio.com]` por la dirección real.

| Abre | Debes ver |
|---|---|
| `https://[ranking.tu-dominio.com]/api/health` | `{"ok":true}` |
| `https://[ranking.tu-dominio.com]/api/scores` | `{"top":[]}`, la lista vacía, o con puntajes si ya hay. |
| `https://[ranking.tu-dominio.com]/admin` | La página **"Moderación"** con el campo de la clave. |

Luego, en `/admin`:
1. Entra con tu `ADMIN_KEY`.
2. En **"Nombres reservados"**, reserva `IDZUMI` con tu PIN y `DEX` con el PIN de Dex. El PIN es de 6 a 12 números, y cada quien elige el suyo.
3. Cierra la pestaña: la sesión se borra sola.

**Conectar el juego con el servidor** es un paso aparte y **no se hace en este cambio**. Hay que poner la dirección `https://[ranking.tu-dominio.com]/api/scores` en la línea `<meta name="dsr-api" ...>` de `index.html`, cuando se decida dónde se publica el juego.

---

## 7. ¿Encender `TRUST_PROXY`?

**Para qué sirve:** la app limita cuántos puntajes o intentos de PIN puede mandar cada jugador, según su dirección IP. Si SiteGround pone un intermediario (proxy) delante de la app, puede que la app vea **la misma IP para todos**: la del proxy. Entonces el límite se comparte entre todos los jugadores, y uno solo podría bloquear a los demás por unos minutos.

**Cómo saber si te pasa:** **[por confirmar]**. Pregúntale al soporte de SiteGround:
> "¿Las apps Node.js reciben las visitas a través de un proxy? ¿Ese proxy envía la IP real del visitante en el encabezado `X-Forwarded-For`? ¿Reemplaza ese encabezado o le agrega datos al que mandó el visitante?"

**Qué hacer según la respuesta:**

| Respuesta del soporte | Qué poner |
|---|---|
| No hay proxy, o no envía `X-Forwarded-For`. | Deja `TRUST_PROXY` apagada (`0` o sin poner). |
| Sí hay proxy y **reemplaza** `X-Forwarded-For` con la IP real. | `TRUST_PROXY` = `1` |
| Sí hay proxy pero **agrega** al encabezado que mandó el visitante. | Déjala apagada y avísame. La app toma **la primera** dirección válida de la lista. Si el proxy agrega en vez de reemplazar, un tramposo podría escribir una IP falsa al inicio y saltarse el límite. |

Después de cambiarla, reinicia la app. La línea del registro debe decir `TRUST_PROXY=on`.

---

## 8. Respaldar los datos

Todo lo importante está en **un solo archivo**: `scores.json`, dentro de tu `DATA_DIR`.

**Cómo respaldar:**
1. Abre el Administrador de archivos de Site Tools o conéctate por SFTP. **[por confirmar]** si tu `DATA_DIR` aparece ahí.
2. Ve a la carpeta de `DATA_DIR`.
3. Descarga `scores.json` y guárdalo con la fecha en el nombre, por ejemplo `scores-2026-11-05.json`.

**Cada cuánto:** una vez por semana es suficiente al principio. Hazlo también **siempre antes de actualizar** la app.

**Es un archivo privado:** tiene los PIN cifrados (no se pueden leer, pero mejor no compartirlo). No contiene direcciones IP ni la clave de administración.

**Cómo restaurar un respaldo:**
1. Detén la app.
2. Reemplaza `scores.json` en `DATA_DIR` con tu respaldo.
3. Inicia la app y abre `/api/scores` para comprobar.

> **¿SiteGround hace sus propios respaldos de esta carpeta?** **[por confirmar]**. Haz los tuyos de todos modos.

---

## 9. Regresar a la versión anterior (rollback)

Si una actualización sale mal:

1. **Respalda `scores.json`** primero (sección 8).
2. Detén la app.
3. Borra los 4 archivos de la app (`server.js`, `admin.html`, `blocklist.json`, `package.json`) y sube los del **.zip de la versión anterior** que guardaste en la sección 2.
4. **No toques** la carpeta `DATA_DIR`.
5. Inicia la app y repite las pruebas de la sección 6.

**Ojo con versiones muy viejas:** las versiones **anteriores a la moderación** (antes del PR #2) guardaban los datos en otro formato y no conocen `DATA_DIR`. Si regresas a una de esas, **perderías los bloqueos y los nombres reservados**, y podría arrancar con el ranking vacío. Solo regresa a una versión que ya haya funcionado en línea, y siempre con respaldo.

---

## 10. Lista de lo que está **por confirmar** en SiteGround

- [ ] Si tu plan incluye "Node.js Projects", y el nombre exacto del menú y de los campos.
- [ ] Qué versiones de Node.js ofrece (se necesita la 18 o una más nueva).
- [ ] Si se pide "archivo de inicio" o "comando de inicio", y cuál acepta.
- [ ] Si SiteGround pone `PORT` sola, o si hay que escribirla.
- [ ] Dónde se escriben las variables de entorno.
- [ ] Qué ruta usar para `DATA_DIR` y si la app puede escribir ahí.
- [ ] Si los datos sobreviven a un reinicio y a una actualización de la app.
- [ ] Si hay un proxy delante, y cómo manda la IP real (`X-Forwarded-For`: reemplaza o agrega).
- [ ] Límites de memoria y CPU, y si la app se "duerme" cuando nadie la usa (el primer jugador esperaría unos segundos).
- [ ] Cómo se asigna una dirección web (dominio o subdominio con https) al proyecto Node.js.
- [ ] Dónde se ve el registro (log) de la app.
- [ ] Si SiteGround respalda la carpeta de datos.
