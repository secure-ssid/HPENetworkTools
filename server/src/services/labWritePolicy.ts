/**
 * The one server-side admission policy for lab configuration writes.
 *
 * Lab installs apply supported changes immediately by default. Operators who
 * need the ticketed broker workflow opt into it explicitly with
 * `configMode: false`; a missing value is treated as the lab default so older
 * settings files migrate safely.
 */

import { settings, type Settings } from '../config/settings';

export function allowsLabDirectWrites(value: Pick<Settings, 'configMode'> = settings.get()): boolean {
  return value.configMode !== false;
}
