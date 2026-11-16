// DEVICE-05: emulate a real device's quirks.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DeviceError, loadDevice, QUIRK_NAMES, QUIRKS, validateDefinition } from '../src/index.js';
import { byteSession, notificationsVariant, notifySession, waitFor } from './notify-helpers.js';
import { errorTags } from './writes-helpers.js';

const schemaFile = fileURLToPath(new URL('../schemas/device.schema.json', import.meta.url));
const BAD = '<get-config><source><nowhere/></source></get-config>';

async function schemaValidator(): Promise<(v: unknown) => boolean> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(JSON.parse(await readFile(schemaFile, 'utf8')) as object) as (v: unknown) => boolean;
}

describe("DEVICE-05 emulate a real device's quirks", () => {
  it("AC1: quirks are named entries in the definition, each with its own settings, documented in the definition's JSON Schema", async () => {
    const schema = JSON.parse(await readFile(schemaFile, 'utf8')) as { properties: { quirks: { properties: Record<string, { description: string }> } } };
    expect(Object.keys(schema.properties.quirks.properties)).toEqual([...QUIRK_NAMES]);
    for (const q of QUIRKS) expect(schema.properties.quirks.properties[q.name]!.description).not.toBe('');
    const valid = await schemaValidator();
    const def = { id: 'q', yang: { modules: [] }, quirks: { replyWithoutMessageId: { replies: 'all' }, invalidXmlChars: true, subtreeFilterLimit: { depth: 3, message: 'No.' } } };
    expect(valid(def)).toBe(true);
    expect(validateDefinition(def)).toEqual([]);
    expect(valid({ ...def, quirks: { slowCloseSession: { delay: 'soon' } } })).toBe(false);
    expect(validateDefinition({ ...def, quirks: { slowCloseSession: { delay: 'soon' } } })).toEqual([{ path: '$.quirks.slowCloseSession', message: 'delay must be a number' }]);
  });

  it('AC2: the catalogue covers replies without a message-id, invalid XML characters, padded empty elements, base 1.0 only and limited subtree filters', async () => {
    expect(QUIRK_NAMES).toEqual(expect.arrayContaining(['replyWithoutMessageId', 'invalidXmlChars', 'paddedEmptyElements', 'chunkedFramingBroken', 'subtreeFilterLimit']));
    // Set in the device definition, they reach every session of the device.
    const device = await notificationsVariant((d) => ({ ...d, quirks: { replyWithoutMessageId: true, invalidXmlChars: true, paddedEmptyElements: { indent: 4 } } }));
    const { srv } = await notifySession({ device });
    const c = await byteSession(srv);
    c.send(BAD);
    await waitFor(() => c.text().includes('</rpc-reply>'));
    const reply = c.text().slice(c.text().indexOf('<rpc-reply'));
    expect(reply).not.toContain('message-id');
    expect(reply).toContain('\u0007</error-message>');
    await srv.running.applyExternal({ 'notif-test:servers': { server: [{ name: 'p', description: '' }] } }, { source: 'test' });
    c.send('<get-config><source><running/></source></get-config>');
    await waitFor(() => c.text().includes('<data'));
    expect(c.text()).toContain('<description>\n    </description>');

    const broken = await notificationsVariant((d) => ({ ...d, quirks: { chunkedFramingBroken: true } }));
    const b = await byteSession((await notifySession({ device: broken })).srv);
    b.send('<discard-changes/>');
    await waitFor(() => / \n<\?xml/.test(b.text()));
    expect(b.text()).toMatch(/\n#\d+ \n/);
  });

  it('AC3: with no quirks set, the server behaves as the RFCs require', async () => {
    const { c, srv } = await notifySession();
    const reply = await c.call(BAD);
    expect(errorTags(reply)).toEqual(['invalid-value']);
    // eslint-disable-next-line no-control-regex -- looking for control characters is the point
    expect(c.raw.texts.every((t) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t))).toBe(true);
    await srv.running.applyExternal({ 'notif-test:servers': { server: [{ name: 'p', description: '' }] } }, { source: 'test' });
    await c.call('<get-config><source><running/></source></get-config>');
    expect(c.raw.texts.at(-1)).toContain('<description/>');
    // Requests pipelined and deep subtree filters are answered.
    const deep = '<get-config><source><running/></source><filter><servers xmlns="urn:example:notif"><server><name>a</name><port/></server></servers></filter></get-config>';
    const answers = await Promise.all([c.call(deep), c.call(deep)]);
    expect(answers.map(errorTags)).toEqual([[], []]);
  });

  it('AC4: quirks apply only to sessions of that device, never to control sessions', async () => {
    const device = await notificationsVariant((d) => ({ ...d, quirks: { replyWithoutMessageId: { replies: 'all' } } }));
    const { srv, open } = await notifySession({ device, control: { users: ['admin'] } });
    // call() waits for a reply by its message-id: the control session's replies have theirs.
    const admin = await open('admin');
    expect(errorTags(await admin.call(BAD))).toEqual(['invalid-value']);
    const other = await notifySession();
    expect(errorTags(await other.c.call(BAD))).toEqual(['invalid-value']);
    void srv;
  });

  it('AC5: an unknown quirk name is rejected when the definition loads', async () => {
    const err = await loadDevice({ id: 'q', yang: { modules: [] }, quirks: { noSuchQuirk: true } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect((err as DeviceError).issues).toEqual([{ path: '$.quirks.noSuchQuirk', message: 'is not a known quirk' }]);
  });
});
