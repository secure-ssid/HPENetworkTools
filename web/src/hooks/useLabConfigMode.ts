import { useEffect, useState } from 'react';
import { getPortalSettings } from '../api/settings';

/**
 * Direct-write panels fail closed: until the portal has confirmed lab mode,
 * they retain the hardened review confirmation.
 */
export function useLabConfigMode(): { lab: boolean } {
  const [lab, setLab] = useState(false);

  useEffect(() => {
    let current = true;
    void getPortalSettings()
      .then((portal) => {
        if (current && portal !== null) setLab(portal.configMode !== false);
      })
      .catch(() => {
        // The initial hardened value is the intentional unavailable fallback.
      });
    return () => {
      current = false;
    };
  }, []);

  return { lab };
}
