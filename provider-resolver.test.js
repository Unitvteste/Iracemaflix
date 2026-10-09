'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test, PROVIDERS } = require('./provider-resolver');

test('registra seis adapters independentes', () => {
  assert.equal(Object.keys(PROVIDERS).length, 6);
  assert.ok(PROVIDERS.peachify);
  assert.ok(PROVIDERS.reidosembeds);
});

test('aceita apenas domínios próprios/subdomínios do provedor', () => {
  assert.equal(_test.allowedHost('www.redflix.co', PROVIDERS.redflix), true);
  assert.equal(_test.allowedHost('evilredflix.co', PROVIDERS.redflix), false);
  assert.equal(_test.allowedHost('127.0.0.1', PROVIDERS.redflix), false);
});

test('reconhece endereços públicos e bloqueia faixas reservadas comuns', () => {
  assert.equal(_test.isIpPublic('8.8.8.8'), true);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.2', '169.254.1.1', '172.20.0.1', '::1', 'fc00::1']) {
    assert.equal(_test.isIpPublic(ip), false, ip);
  }
});

test('extrai HLS/MP4 de tags e URLs estáticas, sem executar scripts', () => {
  const html = `
    <video><source src="https://cdn.example/video.mp4?token=abc" type="video/mp4"></video>
    <script>const hls = "https:\\/\\/media.example\\/live.m3u8?key=xyz";</script>
    <a href="https://cdn.example/page.html">página</a>
  `;
  const urls = _test.collectCandidates(html, 'https://peachify.pro/embed/movie/123');
  assert.ok(urls.some((url) => url.includes('video.mp4?token=abc')));
  assert.ok(urls.some((url) => url.includes('.m3u8')));
  assert.equal(urls.some((url) => url.includes('page.html')), false);
});

test('resolve iframes relativos e ignora javascript:', () => {
  const html = '<iframe src="/player/1"></iframe><iframe src="javascript:alert(1)"></iframe>';
  assert.deepEqual(_test.collectIframes(html, 'https://redflix.co/play?id=1'), ['https://redflix.co/player/1']);
});
