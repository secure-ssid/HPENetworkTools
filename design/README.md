# Design prototypes (archive)

The `.dc.html` files in this directory are the archived design prototypes the
portal was built from. They are a historical record, not runnable pages: each
one loads `./support.js` (the design-component runtime) and `./ds-base.js`,
which in turn expects a design-system bundle at a `../../` path — none of
those ship in this repository, so opening the files directly renders nothing.

To read them as specification — markup is layout, the `<script data-dc-script>`
block is state, fixtures, and behaviour — start with
[docs/design-reference.md](../docs/design-reference.md), the reader's guide
to the bundle. `research-notes.md` is the continuous-improvement research log
kept alongside the designs.
