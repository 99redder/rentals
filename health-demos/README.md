# Health exercise demonstration images

Demonstration photos shown in the **Health** tab's "Show me how" panels for
resistance-band exercises. Kept as same-origin files so the app's strict
Content-Security-Policy (`img-src 'self'`) allows them.

Each movement is displayed in-app as a looping animated **`{name}.gif`** — a
Start↔Finish loop morphed (ImageMagick) from two source frames, `-1.jpg` (start)
and `-2.jpg` (finish), which are kept as the source/fallback.

Regenerate a GIF from its frames:

```
magick NAME-1.jpg NAME-2.jpg -resize 300x -morph 5 \( -clone -2-1 \) -loop 0 \
  -set delay '%[fx:(t==0||t==6)?85:7]' -layers optimize NAME.gif
```

| File prefix | Movement | Source exercise |
|---|---|---|
| `chest-fly` | Band chest fly / cross-over | Cross Over – With Bands |
| `row` | Bent-over row | Bent Over Two-Dumbbell Row |
| `curl` | Biceps curl | Dumbbell Bicep Curl |
| `face-pull` | Face pull | Face Pull |
| `pull-apart` | Band pull-apart | Band Pull Apart |
| `triceps-pushdown` | Triceps push-down | Cable Incline Pushdown |
| `overhead-press` | Overhead press | Cable Shoulder Press |

## Attribution / license

Images sourced from the [free-exercise-db](https://github.com/yuhonas/free-exercise-db),
which compiles exercise images originally from **Everkinetic**. Everkinetic images
are published under **CC BY-SA 3.0**. Some movements are demonstrated with the
closest equivalent equipment (dumbbell/cable) where a band-specific photo wasn't
available; the in-app step text describes the band setup.
