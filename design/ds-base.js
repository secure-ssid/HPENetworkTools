// Loads this design system into the template. In a consuming project, point
// base at the bound DS folder relative to this file (e.g. '_ds/<folder>' at
// the project root, '../_ds/<folder>' one level down) — one line to edit.
(() => {
  const base = '../..';
  for (const p of ["fonts/fonts.css","_ds_bundle.css","styles.css"]) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = base + '/' + p;
    document.head.appendChild(l);
  }
  // Table cells rendered through the component runtime each sit in their own
  // pass-through wrapper, so Nightdesk's open-table rules (which flush the
  // first/last cell of a row) end up zeroing padding on every column. Restore
  // interior padding and re-flush the real edge columns.
  const fix = document.createElement('style');
  fix.textContent = '.nd-table__th,.nd-table__td{padding-left:16px!important;padding-right:16px!important}' +
    '.nd-table--compact .nd-table__th,.nd-table--compact .nd-table__td{padding-left:12px!important;padding-right:12px!important}' +
    '.nd-table--open tr>:first-child>.nd-table__th,.nd-table--open tr>:first-child>.nd-table__td{padding-left:0!important}' +
    '.nd-table--open tr>:last-child>.nd-table__th,.nd-table--open tr>:last-child>.nd-table__td{padding-right:0!important}';
  document.head.appendChild(fix);
  const s = document.createElement('script');
  s.src = base + '/_ds_bundle.js';
  s.onerror = () => console.error('ds-base.js: failed to load ' + s.src + ' — if this is a consuming project, point the base line in ds-base.js at the bound _ds/<folder> tree relative to this page (e.g. _ds/<folder> at the project root, ../_ds/<folder> one level down); in a fresh design system this can just mean the bundle is not compiled yet');
  document.head.appendChild(s);
})();
