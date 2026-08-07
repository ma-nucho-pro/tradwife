# Cómo funciona tradwife, en cristiano

Este archivo es para ti, para que entiendas tu propio proyecto sin leer código.
No hace falta que lo subas si no quieres.

---

## El problema en una frase

Tu agente no recuerda nada de una sesión a otra, así que le explicas lo mismo
cada mañana.

## La solución en una frase

Un archivo de texto con lo que ya dijiste, que se le entrega al agente al abrir
cada sesión y se actualiza solo al cerrarla.

---

## Las tres piezas

### 1. Los ganchos (hooks)

Un gancho es un comando que el agente ejecuta solo, en un momento concreto.
No hay magia: Claude Code, Codex y Cursor te dejan registrar comandos y ellos
los llaman.

tradwife registra tres:

| Cuándo | Qué hace |
|---|---|
| Al abrir sesión | lee tu memoria y se la pasa al agente |
| Cada vez que escribes | guarda lo que escribiste en un buffer temporal |
| Al cerrar sesión | mira ese buffer, decide qué merece guardarse, y borra el buffer |

Esa última línea es importante: **el texto crudo de tus prompts se borra.** Solo
sobreviven los hechos destilados.

### 2. El curador

Aquí está el producto entero. Guardar texto es trivial; decidir qué guardar es
lo difícil.

Cuando cierras sesión, tradwife mira lo que escribiste y aplica cuatro pasos:

**Extrae.** Busca frases con forma de hecho duradero: "recuerda que…",
"siempre…", "nunca…", "prefiero…", "no uses…", "usamos…". No usa ningún modelo
de IA — son reglas de patrones escritas a mano. Por eso no cuesta nada, no
necesita API key, no hace ninguna llamada por red, y puedes leer las reglas y
predecir qué va a guardar.

**Filtra.** Tira todo lo que sea una pregunta, una tarea ("arregla el bug"),
código, una ruta, una URL, un log pegado o algo con pinta de credencial.

**Espera.** Y esta es la regla clave: **lo que dices una vez no se guarda.**
Queda en espera y tiene que volver a aparecer en *otra sesión distinta* para
entrar. La excepción es cuando lo dices a propósito ("recuerda que…"), porque
ahí sí lo dijiste queriendo.

Sin esta regla, a las dos semanas tendrías cuatrocientas "memorias", varias
contradiciéndose, y habrías dejado de fiarte de todas.

**Poda.** Hay un techo duro: 1200 tokens para lo que eres tú, 800 para el
proyecto. Cuando se llena **no crece**: expulsa el hecho de menor valor. La
puntuación es confianza × recencia × repetición × intención.

Ese techo es la decisión de diseño central. Sin límite, cualquier memoria acaba
siendo una copia peor de tu historial, y encima te cuesta tokens en cada turno.

### 3. El archivo

`~/.tradwife/identity.md` es un markdown normal. Lo abres, lo lees, lo editas.

- Borras una línea → se olvida. Sin comando.
- Escribes una línea a mano → se guarda con confianza total.

El archivo manda siempre sobre lo que tradwife crea saber. Nunca peleas contra
la herramienta por el control de tu propia memoria.

---

## Lo que la hace distinta de guardar notas

**Separa lo que eres tú de lo que es el repo.** "Responde en español" te sigue a
todos los proyectos. "No hagas commit a main" se queda en ese repo. Y si dices
lo mismo en tres repos distintos, deja de ser una regla de casa y sube sola a tu
identidad, porque a esas alturas es cómo trabajas tú.

**Resuelve contradicciones en vez de apilarlas.** Si antes usabas Redis y ahora
dices que no, el hecho viejo se reemplaza y queda registrado el cambio.

**Deja ir lo que dejaste de creer.** Si pasas meses sin mencionar algo, se marca
como dormido: sale del contexto pero sigue visible en el archivo. Lo dices otra
vez y vuelve. Nada se pudre en silencio.

**Solo lee lo que escribes tú.** Las respuestas del agente nunca se minan. Si el
modelo propone Postgres y contestas "ok", no aprendió nada de ti — se oyó a sí
mismo. Ahí es donde la mayoría de sistemas se llenan de basura.

**Cada hecho es rastreable.** `tradwife why "<hecho>"` te dice de qué sesión
salió, la frase exacta que escribiste, en cuántas sesiones apareció y qué
reemplazó. Si no puedes auditar por qué está algo ahí, dejas de fiarte de todo.

---

## Los guards: cuándo una regla se aplica de verdad

Una regla inyectada como texto es una sugerencia. El agente casi siempre la
sigue. Casi no es siempre.

`tradwife harden` busca las reglas que un gancho **puede** hacer cumplir y te
ofrece convertirlas en bloqueos reales:

| Tu regla | El guard |
|---|---|
| "Nunca commit directo a main" | bloquea `git commit` **estando en main** |
| "Nunca force push" | bloquea `--force`, permite `--force-with-lease` |
| "No uses npm" | bloquea `npm install` |

Nada se activa sin que lo apruebes una por una, porque un bloqueo inventado de
una frase que no era una regla dura te impide trabajar.

La regla se queda **además** en la memoria, y eso es a propósito: el guard
impide el error, el contexto evita el intento. Sin lo segundo, el agente lo
intenta igual y se come el bloqueo cada vuelta.

Y ojo: la mayoría de lo que guarda tradwife (tono, idioma, preferencias) no
corresponde a ninguna llamada a herramienta, así que un gancho no puede
expresarlo ni queriendo. Por eso conviven las dos capas.

---

## Cómo viaja entre tus máquinas

Esta es la parte nueva y la que más te va a servir para explicarlo.

**El truco que la gente usa.** Subir la carpeta de memoria a un repo privado.
Funciona hasta el día que usas dos máquinas en la misma semana: entonces git te
da un conflicto de texto en un archivo lleno de hechos y te obliga a elegir un
bando. Cualquier bando pierde algo.

**Lo que hace tradwife.** Como cada hecho tiene un identificador por contenido y
lleva sus propios metadatos (cuántas veces lo dijiste, en qué sesiones, cuándo
fue la última), se pueden fusionar **por significado** en vez de por línea:

- El mismo hecho en las dos → se suman las sesiones, gana la fecha más reciente
- Solo en una y estaba antes → la otra lo borró → **gana el borrado**
- Solo en una y es nuevo → entra
- Se contradicen → gana el más reciente

Y una consecuencia bonita que salió gratis: **la regla de las dos sesiones ahora
cruza máquinas.** Lo dices en el portátil y en el sobremesa, y se guarda.

**La configuración.** Si tienes `gh` (la CLI de GitHub) con sesión iniciada —
que es lo normal en quien usa agentes — es un comando:

```
tradwife sync setup
```

Te crea un repo **privado** en tu cuenta y sube. En la segunda máquina,
`tradwife clone` lo encuentra solo. A partir de ahí se sincroniza al abrir y al
cerrar cada sesión, sin que hagas nada.

Si no tienes `gh`, no se rompe: te dice qué falta, te da el comando de
instalación para tu sistema, y te ofrece la ruta manual (crea tú el repo privado
y pásale la URL). Las dos rutas están probadas.

**Por qué git y no MCP.** MCP sirve para darle herramientas a un agente durante
una conversación. Sincronizar memoria no es algo que el agente haga: pasa antes
y después de la sesión, y es un problema de archivos y red. Git ya sabe
fusionar, versionar y funcionar sin conexión. Un servidor MCP añadiría un
proceso que tiene que estar corriendo para algo que `git push` ya hace, y metería
un punto de fallo entre tú y tu propia memoria.

---

## Lo que nunca sale de tu máquina

- **Los prompts crudos.** Viven en un buffer que se borra al curar la sesión, y
  la carpeta está en el `.gitignore`. No se suben nunca.
- **Las credenciales.** Cualquier cosa con forma de clave, token, JWT, cadena de
  conexión o bloque de clave privada descarta el candidato entero — no se
  enmascara, se tira. Hay un test que busca la credencial en todo el historial
  de git y falla si aparece.
- **Nada más.** No hay telemetría, ni analítica, ni cuentas, ni llamadas a
  ningún servidor.

---

## Qué hay dentro de la carpeta

```
~/.tradwife/
  identity.md            tú. editable a mano, es la fuente de verdad
  identity.index.json    confianza, cuántas veces, de dónde salió
  projects/
    mi-repo-a1b2c3d4/
      project.md         este repo. mismas reglas
  sessions/              buffers temporales, se borran al curar
  guards.json            los bloqueos que aprobaste
  cross-project.json     qué hechos aparecen en más de un repo
  journal.jsonl          registro de cada cambio, solo se añade
  .last-sync             marca de tiempo, local a esta máquina
```

Los `.md` son lo que lees y editas. Los `.json` guardan metadatos que no tienen
sitio legible en una lista de viñetas.

---

## Los cuatro agentes, sin adornos

| | Inyecta | Aprende | Guards |
|---|---|---|---|
| Claude Code | sí | sí | sí |
| Codex | sí | sí | sí |
| Cursor | sí (archivo de reglas) | sí | sí |
| Gemini CLI | sí (`GEMINI.md`) | **no** | **no** |

Cursor no tiene un evento de inicio de sesión que pueda inyectar contexto, así
que la memoria entra por un archivo de reglas que se reescribe al cerrar. Va una
sesión por detrás en hechos recién aprendidos.

Gemini CLI tiene ganchos, pero no los nombres de sus eventos verificados. Un
gancho apuntando a un evento inexistente **no falla: simplemente nunca se
ejecuta**, y el usuario creería que aprende cuando no. Por eso solo inyección, y
el README lo dice con un "no" en negrita.

Los cuatro leen la misma memoria. Lo aprendido en Claude Code aparece en Codex.

---

## Si alguien te pregunta en qué se diferencia

**De CLAUDE.md:** ese lo escribes tú, y solo guarda lo que te acordaste de
escribir. Este se llena solo de lo que ya escribiste trabajando.

**De la memoria automática nativa:** esa es por repositorio. Lo que aprende en un
repo no aparece en otro, y la capa global sigue siendo un archivo que mantienes
a mano.

**De las herramientas que indexan sesiones:** esas recuerdan **el trabajo** (qué
bug arreglasteis, qué decidisteis). Esta recuerda **a la persona**. Conviven.

**De tmux:** tmux mantiene vivo el proceso. No mantiene vivo lo que el proceso
aprendió.
