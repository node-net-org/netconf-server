// WRITE-02: the three error-options of edit-config (RFC 6241 §7.2).
import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, rpcErrors, send, WT, writesSession, writesVariant } from './writes-helpers.js';

const NC_ATTR = 'xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"';
/** Three interfaces to create: the middle one already exists, so it fails. */
const THREE = `<interfaces xmlns="${WT}" ${NC_ATTR}>
  <interface nc:operation="create"><name>a1</name><type>t</type></interface>
  <interface nc:operation="create"><name>eth0</name><type>t</type></interface>
  <interface nc:operation="create"><name>z9</name><type>t</type></interface>
</interfaces>`;
const TWO_BAD = `<interfaces xmlns="${WT}" ${NC_ATTR}>
  <interface nc:operation="create"><name>a1</name><type>t</type></interface>
  <interface nc:operation="create"><name>eth0</name><type>t</type></interface>
  <interface nc:operation="delete"><name>nope</name></interface>
  <interface nc:operation="create"><name>z9</name><type>t</type></interface>
</interfaces>`;

async function names(c: Awaited<ReturnType<typeof writesSession>>['c'], device: Awaited<ReturnType<typeof writesSession>>['device']): Promise<string[]> {
  const json = (await config(c, device)) as { 'writes-test:interfaces': { interface: { name: string }[] } };
  return json['writes-test:interfaces'].interface.map((i) => i.name);
}

describe('WRITE-02 error-option', () => {
  it('rollback-on-error applies nothing when any part fails, and reports every error', async () => {
    const { c, device } = await writesSession();
    const reply = await send(c, editConfig('running', TWO_BAD, '<error-option>rollback-on-error</error-option>'));
    expect(errorTags(reply)).toEqual(['data-exists', 'data-missing']);
    expect(await names(c, device)).toEqual(['eth0']);
    // Only with :rollback-on-error.
    const without = await writesSession({ device: await writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, rollbackOnError: false } })) });
    expect(errorTags(await send(without.c, editConfig('running', THREE, '<error-option>rollback-on-error</error-option>')))).toEqual(['invalid-value']);
  });

  it('stop-on-error (the default) keeps what came before the first error and nothing after it', async () => {
    const { c, device } = await writesSession();
    const reply = await send(c, editConfig('running', THREE));
    expect(errorTags(reply)).toEqual(['data-exists']);
    expect(await names(c, device)).toEqual(['eth0', 'a1']);
  });

  it('continue-on-error skips each failing part, applies the rest, and reports each failure', async () => {
    const { c, device } = await writesSession();
    const reply = await send(c, editConfig('running', TWO_BAD, '<error-option>continue-on-error</error-option>'));
    expect(errorTags(reply)).toEqual(['data-exists', 'data-missing']);
    expect(await names(c, device)).toEqual(['eth0', 'a1', 'z9']);
  });

  it('rejects a result that fails validation in full, whatever the error-option', async () => {
    for (const option of ['stop-on-error', 'continue-on-error', 'rollback-on-error']) {
      const { c, device } = await writesSession();
      // a1 is fine; the second entry repeats eth0's address, which breaks unique.
      const edit = `<interfaces xmlns="${WT}"><interface><name>a1</name><type>t</type></interface><interface><name>b1</name><type>t</type><address>10.0.0.1</address></interface></interfaces>`;
      const reply = await send(c, editConfig('running', edit, `<error-option>${option}</error-option>`));
      expect(errorTags(reply), option).toEqual(['operation-failed']);
      expect(await names(c, device), option).toEqual(['eth0']);
    }
  });

  it('names the failing node in error-path', async () => {
    const { c } = await writesSession();
    const reply = await send(c, editConfig('running', TWO_BAD, '<error-option>continue-on-error</error-option>'));
    const errors = rpcErrors(reply);
    expect(errors.map((e) => e.path)).toEqual([
      "/writes-test:interfaces/writes-test:interface[writes-test:name='eth0']",
      "/writes-test:interfaces/writes-test:interface[writes-test:name='nope']",
    ]);
    // The prefix is declared on error-path, so the path is a usable XPath.
    const path = errors[0]!.element.child('error-path', 'urn:ietf:params:xml:ns:netconf:base:1.0')!;
    expect(path.inScope.get('writes-test')).toBe(WT);
    expect(isOk(reply)).toBe(false);
  });
});
