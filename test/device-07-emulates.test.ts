// DEVICE-07: have the client detect the emulated device as its profile.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { autoDetect, builtinDeviceProfiles, connect } from '@node-net/netconf';
import { describe, expect, it } from 'vitest';
import { createServer, loadDeviceFile, validateDefinition, type Device } from '../src/index.js';

const DEVICES = fileURLToPath(new URL('../devices/', import.meta.url));
const shipped = readdirSync(DEVICES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  // Devices that emulate a client profile; the lab device emulates none.
  .filter((name) => (JSON.parse(readFileSync(`${DEVICES}${name}/device.json`, 'utf8')) as { emulates?: string }).emulates !== undefined)
  .sort();

async function device(name: string): Promise<Device> {
  return loadDeviceFile(`${DEVICES}${name}/device.json`);
}

describe('DEVICE-07 have the client detect the emulated device as its profile', () => {
  it('AC1: a device definition can name the client profile it emulates', async () => {
    for (const name of shipped) {
      const d = await device(name);
      expect(d.emulates, name).toBe(name);
      expect(validateDefinition(d.definition)).toEqual([]);
    }
    expect(validateDefinition({ id: 'x', emulates: 'some-profile', yang: { modules: [] } })).toEqual([]);
  });

  it("AC2: @node-net/netconf with automatic detection selects that profile from the emulated device's hello, and reads its data", async () => {
    const profiles = await builtinDeviceProfiles();
    for (const name of shipped) {
      const srv = await createServer({ device: await device(name) });
      const client = await connect({ transport: srv.transport(), profile: autoDetect(profiles) });
      expect(client.profile?.id, name).toBe(name);
      // The profile's own paths read the emulated device's data.
      const systemName = client.profile?.paths?.['systemName'];
      if (systemName !== undefined) expect(await client.content.readValue(systemName, { format: 'xml' }), name).toMatch(/^emulated-/);
      await client.close();
      await srv.close();
    }
  });

  it('AC3: a test fails when an emulating device is no longer detected as its profile', async () => {
    // The check above, turned round: a device that drops the module its profile matches on is detected as nothing.
    const profiles = await builtinDeviceProfiles();
    const d = await device('nokia-sros-md');
    const def = d.definition;
    const srv = await createServer({ device: { ...def, yang: { modules: [] }, data: {} } });
    const client = await connect({ transport: srv.transport(), profile: autoDetect(profiles) });
    expect(client.profile?.id).not.toBe('nokia-sros-md');
    await client.close();
  });

  it('AC4: the package ships a device definition for every auto-detectable profile @node-net/netconf ships', async () => {
    // A profile with no match rule (such as lab, which only names paths for the docs) is never
    // auto-detected, so there is no detection for an emulating device to prove.
    const ids = (await builtinDeviceProfiles())
      .filter((p) => p.match !== undefined)
      .map((p) => p.id)
      .sort();
    expect(shipped).toEqual(ids);
    expect(ids).toEqual(expect.arrayContaining(['nokia-7210-sas', 'sysrepo-netopeer2']));
  });
});
