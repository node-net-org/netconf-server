// WRITE-03: edit-data on the writable NMDA datastores (RFC 8526 §3.1.2).
import { describe, expect, it } from 'vitest';
import { encodeJson, decodeXml } from '@node-net/yang/core';
import { config, DS, errorTags, isOk, NMDA, send, WT, writesSession } from './writes-helpers.js';

const editData = (datastore: string, content: string, params = ''): string =>
  `<edit-data xmlns="${NMDA}" xmlns:ds="${DS}"><datastore>ds:${datastore}</datastore>${params}<config>${content}</config></edit-data>`;
const NC_ATTR = 'xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"';

describe('WRITE-03 edit-data', () => {
  it('applies the same operations and default-operation as edit-config to running and the candidate', async () => {
    for (const datastore of ['running', 'candidate']) {
      const { c, device } = await writesSession();
      expect(isOk(await send(c, editData(datastore, `<system xmlns="${WT}"><hostname>nmda</hostname></system>`)))).toBe(true);
      const del = `<interfaces xmlns="${WT}" ${NC_ATTR}><interface nc:operation="delete"><name>eth0</name></interface></interfaces>`;
      expect(isOk(await send(c, editData(datastore, del)))).toBe(true);
      expect(errorTags(await send(c, editData(datastore, del)))).toEqual(['data-missing']);
      const replace = `<system xmlns="${WT}"><hostname>only</hostname></system>`;
      expect(isOk(await send(c, editData(datastore, replace, '<default-operation>replace</default-operation>')))).toBe(true);
      expect(await config(c, device, datastore)).toEqual({ 'writes-test:system': { hostname: 'only' } });
    }
  });

  it('answers an edit of a read-only datastore (intended, operational) with invalid-value', async () => {
    const { c } = await writesSession();
    for (const datastore of ['intended', 'operational', 'startup']) {
      expect(errorTags(await send(c, editData(datastore, `<system xmlns="${WT}"><hostname>x</hostname></system>`))), datastore).toEqual(['invalid-value']);
    }
  });

  it('makes an edit visible through get-config and get-data alike', async () => {
    const { c, device } = await writesSession();
    await send(c, editData('running', `<system xmlns="${WT}"><hostname>both</hostname></system>`));
    expect(await config(c, device)).toMatchObject({ 'writes-test:system': { hostname: 'both' } });
    const reply = await send(c, `<get-data xmlns="${NMDA}" xmlns:ds="${DS}"><datastore>ds:running</datastore></get-data>`);
    const data = reply.child('data', NMDA)!;
    expect(encodeJson(decodeXml(device.schema.forDatastore('running'), data.elements))).toMatchObject({ 'writes-test:system': { hostname: 'both' } });
  });
});
