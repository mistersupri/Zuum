const { chromium } = require('playwright');
// End-to-end smoke test: two browsers (host + guest) with fake camera/mic.
// Needs the full stack running locally with STT_PROVIDER=mock and LLM_PROVIDER=mock.
// Run: node e2e/smoke.cjs   (BASE_URL defaults to http://localhost:5173)
const OUT = process.env.SHOTS_DIR || __dirname + '/shots';
require('fs').mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const log = (...a) => console.log('[e2e]', ...a);

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = global.errors = [];
  const mk = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    page.on('console', async (m) => { if (m.type() === 'error') { const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?'))); errors.push(`${name}: ${m.text().slice(0,120)} || ${String(args.slice(-1)[0]).slice(0,600)}`); } });
    page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
    return { ctx, page };
  };
  const host = await mk('host');
  const p = host.page;
  const email = `rina${Date.now()}@zuum.test`;

  // Register
  await p.goto(BASE + '/daftar');
  await p.screenshot({ path: OUT + '/01-register.png' });
  await p.fill('#name', 'Rina Wulandari');
  await p.fill('#email', email);
  await p.fill('#password', 'short');
  await p.click('button[type=submit]');
  await p.waitForSelector('text=Kata sandi minimal 10 karakter');
  log('validation error shown for short password');
  await p.fill('#password', 'rahasia-panjang-123');
  await p.click('button[type=submit]');
  await p.waitForURL(BASE + '/');
  await p.waitForSelector('text=Belum ada rapat yang selesai');
  await p.screenshot({ path: OUT + '/02-dashboard-empty.png' });
  log('registered, dashboard empty state');

  // Create meeting via form
  await p.click('text=Atur rapat');
  await p.waitForURL(BASE + '/rapat/baru');
  await p.click('button:has-text("Buat dan masuk")');
  await p.waitForSelector('text=Judul meeting wajib diisi.');
  await p.fill('#title', 'Rapat Koordinasi Persiapan Acara');
  await p.fill('#agenda', 'Pembukaan');
  await p.keyboard.press('Enter');
  await p.fill('#agenda', 'Pembagian tugas');
  await p.click('button:has-text("Tambah")');
  await p.screenshot({ path: OUT + '/03-create.png', fullPage: true });
  await p.click('button:has-text("Buat dan masuk")');
  await p.waitForURL(/\/m\/[a-z0-9]+$/);
  const meetingId = p.url().split('/m/')[1];
  log('meeting created', meetingId);
  const invite = await p.evaluate((id) => sessionStorage.getItem('zuum-invite:' + id), meetingId);
  log('invite url', invite ? 'present' : 'missing');

  // Join preview
  await p.waitForSelector('text=Sebelum masuk');
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + '/04-join-host.png' });
  const disabled = await p.locator('button[type=submit]').isDisabled();
  log('join disabled before consent:', disabled);
  await p.check('input[type=checkbox]');
  await p.click('button[type=submit]');
  await p.waitForURL(/\/ruang$/);
  await p.waitForSelector('text=Transkripsi aktif');
  log('host in room');

  // Guest
  const guest = await mk('guest');
  const g = guest.page;
  await g.goto(invite);
  await g.waitForSelector('#guest-name');
  await g.fill('#guest-name', 'Budi Santoso');
  await g.check('input[type=checkbox]');
  await g.screenshot({ path: OUT + '/05-join-guest.png' });
  await g.click('button[type=submit]');
  await g.waitForSelector('text=Menunggu persetujuan host');
  await g.screenshot({ path: OUT + '/06-guest-waiting.png' });
  log('guest waiting');

  // Host admits
  await p.waitForSelector('text=menunggu di ruang tunggu', { timeout: 10000 });
  log('host toast for waiting guest');
  await p.click('button[aria-label="Peserta"]');
  await p.waitForSelector('text=Ruang tunggu (1)');
  await p.screenshot({ path: OUT + '/07-host-lobby.png' });
  await p.click('button[aria-label="Terima Budi Santoso"]');
  await g.waitForURL(/\/ruang$/, { timeout: 15000 });
  log('guest admitted and in room');

  // Chat
  await g.click('button[aria-label="Chat"]');
  await g.fill('input[aria-label="Tulis pesan"]', 'Halo semua, saya sudah masuk.');
  await g.click('button[aria-label="Kirim"]');
  await p.waitForSelector('button[aria-label="Chat"] >> text=1', { timeout: 8000 }).catch(() => log('WARN no unread badge'));
  await p.click('button[aria-label="Chat"]');
  await p.waitForSelector('text=Halo semua, saya sudah masuk.');
  log('chat delivered');

  // Transcript (mock STT from fake audio)
  await p.click('button[aria-label="Transkrip"]');
  await p.waitForSelector('text=[uji STT] ucapan terdeteksi', { timeout: 45000 });
  await p.waitForTimeout(2500);
  const segs = await p.locator('li[id^=seg-]').count();
  log('transcript segments visible to host:', segs);
  await p.screenshot({ path: OUT + '/08-room-transcript.png' });
  await g.screenshot({ path: OUT + '/09-guest-room.png' });

  // Host correction
  await p.locator('li[id^=seg-]').first().hover();
  await p.locator('button[aria-label="Koreksi segmen"]').first().click();
  await p.fill('textarea[aria-label="Teks segmen"]', 'Selamat pagi, kita mulai rapatnya.');
  await p.click('button:has-text("Simpan")');
  await p.waitForSelector('text=dikoreksi');
  log('segment corrected');

  // Host controls: lock + recording attempt
  await p.click('button[aria-label="Kontrol host"]');
  await p.screenshot({ path: OUT + '/10-host-menu.png' });
  await p.click('text=Kunci rapat');
  await p.waitForSelector('text=Terkunci');
  log('locked');
  await p.click('button[aria-label="Kontrol host"]');
  await p.click('text=Mulai rekam');
  await p.waitForSelector('text=Menyiapkan perekaman', { timeout: 3000 }); log('recording progress toast shown');
  await p.waitForSelector('text=Perekaman gagal dimulai', { timeout: 20000 });
  log('recording failure surfaced (no egress locally)');

  // Mobile room view for guest
  await g.setViewportSize({ width: 390, height: 844 });
  await g.waitForTimeout(500);
  await g.screenshot({ path: OUT + '/11-guest-mobile.png' });
  const overflow = await g.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  log('guest mobile horizontal overflow:', overflow);

  // End meeting
  await p.click('button:has-text("Keluar")');
  await p.waitForSelector('text=Akhiri untuk semua');
  await p.click('text=Akhiri untuk semua');
  await p.waitForSelector('text=Rapat telah berakhir');
  await g.waitForSelector('text=Rapat telah berakhir', { timeout: 10000 });
  log('meeting ended for both');
  await g.screenshot({ path: OUT + '/12-guest-ended.png' });

  await p.click('text=Buka halaman rapat');
  await p.waitForSelector('h1:has-text("Rapat Koordinasi Persiapan Acara")');
  await p.waitForSelector('text=Versi 1', { timeout: 60000 });
  await p.screenshot({ path: OUT + '/13-detail-summary.png', fullPage: true });
  log('summary rendered');
  for (const [tab, file] of [['Transkrip', '14-detail-transcript'], ['Notulen', '15-detail-minutes'], ['Rekaman', '16-detail-recordings'], ['Keputusan', '17-detail-decisions']]) {
    await p.click(`[role=tab]:has-text("${tab}")`);
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${OUT}/${file}.png`, fullPage: true });
  }
  const [dl] = await Promise.all([p.waitForEvent('download'), (async () => { await p.click('[role=tab]:has-text("Transkrip")'); await p.click('text=Unduh transkrip'); await p.click('text=Word (.docx)'); })()]);
  log('download', dl.suggestedFilename());
  await p.click('[role=tab]:has-text("Notulen")');
  const [dl2] = await Promise.all([p.waitForEvent('download'), (async () => { await p.click('text=Unduh notulen'); await p.click('[role=menuitem]:has-text("PDF")'); })()]);
  log('download', dl2.suggestedFilename());

  // Dark theme + dashboard
  await p.goto(BASE + '/');
  await p.waitForSelector('text=Rapat terakhir');
  await p.screenshot({ path: OUT + '/18-dashboard.png' });
  await p.click('button[aria-haspopup=menu]');
  await p.click('[role=menuitemradio]:has-text("Gelap")');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/19-dashboard-dark.png' });
  await p.goto(BASE + '/rapat/' + meetingId);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: OUT + '/20-detail-dark.png', fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(BASE + '/');
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + '/21-dashboard-mobile-dark.png', fullPage: true });
  log('mobile dashboard overflow:', await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await p.goto(BASE + '/riwayat');
  await p.fill('input[aria-label="Cari rapat"]', 'Selamat pagi');
  await p.waitForSelector('text=cocok di transkrip', { timeout: 8000 });
  log('history full-text search matched transcript');
  await p.screenshot({ path: OUT + '/22-history-mobile.png', fullPage: true });

  log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error("[e2e] FAILED", e.message.split("\n")[0]); console.error(global.errors); process.exit(1); });
