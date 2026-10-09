'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LiveTv = require('./live-tv-provider');

const { _test } = LiveTv;

test('expõe catálogos e prefixos separados para canais e eventos', () => {
  assert.equal(LiveTv.handlesCatalog('iracematv'), true);
  assert.equal(LiveTv.handlesCatalog('iracematv_events'), true);
  assert.equal(LiveTv.handlesCatalog('iracematv_upcoming'), true);
  assert.equal(LiveTv.handlesCatalog('m3u-tv'), false);
  assert.equal(LiveTv.CHANNEL_PREFIX, 'iracematv_channel_');
  assert.equal(LiveTv.EVENT_PREFIX, 'iracematv_event_');
});

test('normaliza IDs de canal/evento em slug seguro e reconhecível', () => {
  assert.equal(_test.slug('São Paulo / Ao Vivo'), 'sao-paulo-ao-vivo');
  assert.equal(_test.channelId({ id: 'Band' }), 'iracematv_channel_band');
  assert.equal(_test.eventId({ title: 'Jogo: A x B' }), 'iracematv_event_jogo-a-x-b');
});

test('aceita payload JSON da API com lista aninhada', () => {
  assert.deepEqual(_test.toArrayPayload({ success: true, data: [{ id: 1 }, { id: 2 }], total: 2 }), [{ id: 1 }, { id: 2 }]);
});

test('reconhece somente links HLS diretos para reprodução', () => {
  assert.equal(_test.isDirectM3u8('https://cdn.example/live.m3u8?token=x'), true);
  assert.equal(_test.isDirectM3u8('https://example/player?id=1'), false);
  assert.equal(_test.isDirectM3u8('javascript:alert(1)'), false);
});

test('extrai links M3U8 absolutos, relativos e escapados', () => {
  const html = '<script>file:"https:\\/\\/cdn.example\\/live.m3u8?key=1"</script><source src="/channel/index.m3u8?x=2">';
  const urls = _test.extractM3u8Urls(html, 'https://player.example/watch/');
  assert.ok(urls.includes('https://cdn.example/live.m3u8?key=1'));
  assert.ok(urls.includes('https://player.example/channel/index.m3u8?x=2'));
});

test('extrai iframes e ignora protocolos inseguros e rastreadores', () => {
  const html = '<iframe src="https://embed.example/player"></iframe><script src="https://analytics.example/track.js"></script><iframe src="javascript:alert(1)"></iframe>';
  const links = _test.extractPageLinks(html, 'https://origin.example/page');
  assert.ok(links.some((link) => link.url === 'https://embed.example/player' && link.kind === 'iframe'));
  assert.equal(links.some((link) => link.url.includes('analytics.example')), false);
  assert.equal(links.some((link) => link.url.startsWith('javascript:')), false);
});

test('bloqueia endereços de rede privada/reservada durante captura', () => {
  for (const ip of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1']) {
    assert.equal(_test.isPublicIp(ip), false, ip);
  }
  assert.equal(_test.isPublicIp('1.1.1.1'), true);
});
