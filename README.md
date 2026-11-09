# Zuum

Aplikasi rapat video berbasis web dengan transkrip Bahasa Indonesia real-time per peserta dan notulen berbantuan AI. Dibangun dari PRD "AI Online Meeting" v1.0.

- **Media**: WebRTC lewat LiveKit (SFU). Audio/video tidak pernah melewati API Node.js.
- **Transkrip**: worker bergabung ke room sebagai peserta tersembunyi, berlangganan audio setiap peserta, dan mengirim tiap track ke STT. Identitas pembicara berasal dari track milik peserta yang terautentikasi, bukan tebakan diarization.
- **AI**: setelah rapat berakhir, transkrip difinalisasi lalu Claude menyusun topik, keputusan, tindak lanjut, ringkasan, dan notulen sebagai keluaran terstruktur yang divalidasi schema. Setiap rujukan ke segmen transkrip diperiksa; item tanpa bukti ditandai "perlu ditinjau".

## Struktur

```
apps/api       Fastify + TypeScript: auth, RBAC, meeting, lobby, token LiveKit, webhook, SSE, ekspor
apps/worker    BullMQ: agen transkripsi per room (LiveKit rtc-node + STT), pipeline AI
apps/web       React + Vite + Tailwind: dashboard, join, ruang rapat, hasil rapat
packages/db    Prisma schema + migrasi PostgreSQL
packages/shared  Kontrak event realtime, matriks izin, schema keluaran AI, utilitas transkrip
infra/         Konfigurasi LiveKit, Dockerfile, nginx
e2e/           Uji asap end-to-end (dua browser, kamera/mic palsu)
```

```
Browser ──REST/SSE──> API ──> PostgreSQL
   │                   │ └──> Redis (pub/sub, rate limit, antrean BullMQ)
   └──WebRTC──> LiveKit ──webhook──> API ──outbox──> Worker
                   ▲                                   │
                   └──── agen transkripsi (subscribe audio) ──> STT (Deepgram)
                                                       └──> Claude (pipeline AI)
```

## Menjalankan secara lokal

Prasyarat: Node 22, PostgreSQL 16, Redis 7, dan `livekit-server` (biner atau Docker).

```bash
cp .env.example .env          # isi JWT_SECRET; untuk uji tanpa kunci API pakai STT_PROVIDER=mock dan LLM_PROVIDER=mock
npm install
npm run db:deploy             # menerapkan migrasi ke DATABASE_URL
livekit-server --config infra/livekit.dev.yaml   # terminal terpisah
npm run dev                   # API :4000, worker, web :5173 (Vite mem-proxy /api ke API)
```

Buka http://localhost:5173, daftar akun, lalu klik **Mulai rapat sekarang**.

Dengan Docker Compose (Postgres, Redis, LiveKit, Egress, MinIO, API, worker, web di :8080):

```bash
cp .env.example .env && docker compose up --build
```

Buat bucket `zuum-recordings` di konsol MinIO (http://localhost:9001) sebelum merekam.

### Variabel penting

| Variabel | Fungsi |
|---|---|
| `JWT_SECRET` | Kunci tanda tangan token akses/tamu, minimal 32 karakter |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Koneksi ke LiveKit; kunci yang sama memverifikasi webhook |
| `STT_PROVIDER`, `DEEPGRAM_API_KEY`, `STT_LANGUAGE=id` | Penyedia transkripsi. `mock` tidak mengenali ucapan, hanya memberi segmen uji berlabel |
| `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Penyedia AI (default `claude-opus-5-5`). `mock` mengembalikan hasil kosong berlabel |
| `S3_*` | Penyimpanan rekaman (S3, R2, MinIO). Tanpa ini rekaman tidak dapat diputar |
| `RECORD_INDIVIDUAL_AUDIO` | Rekam juga audio per peserta selama perekaman |
| `REQUIRE_EMAIL_VERIFICATION`, `SMTP_URL` | Verifikasi email dan email reset sandi. Di development, isi email dicetak ke log API |

## Pengujian

```bash
npm test                       # unit test: guardrail AI, chunking, matriks izin, normalisasi timestamp
npm run typecheck
node e2e/smoke.cjs             # butuh stack lokal berjalan + Playwright; STT/LLM mode mock
```

Uji asap E2E menjalankan: registrasi (termasuk validasi), buat rapat, consent wajib sebelum masuk, tamu via tautan masuk ruang tunggu, host menerima, chat, transkrip langsung dari audio palsu lewat LiveKit, koreksi segmen, kunci rapat, kegagalan perekaman yang terlihat, tampilan mobile, akhiri rapat untuk semua, pipeline AI, ekspor DOCX/PDF, tema gelap, dan pencarian full-text riwayat.

## Cakupan PRD

| Area | Status |
|---|---|
| Auth (register, login, refresh berotasi dengan deteksi reuse, logout, lupa/reset sandi, verifikasi email opsional, profil) | Selesai |
| Rate limit login/join/preview/pencarian/AI | Selesai (Redis) |
| Buat/ubah/batalkan meeting, agenda, passcode (Argon2id), kapasitas, retensi, visibilitas transkrip, wewenang co-host | Selesai |
| Undangan: token acak 256-bit, hanya hash disimpan, kedaluwarsa, batas pakai, cabut, rotasi | Selesai |
| Join: validasi status/undangan/passcode/kunci/kapasitas, consent tercatat (`ConsentEvent`), ruang tunggu, token LiveKit berumur pendek dengan grant minimum, peserta yang dikeluarkan tidak dapat masuk lagi, identitas tidak ganda saat reconnect | Selesai |
| Ruang rapat: grid berpaginasi + tampilan pembicara aktif, simulcast/adaptive stream/dynacast, berbagi layar, chat, panel peserta (virtualisasi `content-visibility`), indikator REC/transkripsi/kunci, status koneksi, reconnect | Selesai |
| Kontrol host: terima/tolak, bisukan, bisukan semua, keluarkan, jadikan co-host, kunci, rekam, akhiri untuk semua | Selesai |
| Recording: egress komposit + audio per peserta, status aset dari webhook, signed URL 10 menit dengan audit | Kode selesai; **belum diuji dengan LiveKit Egress nyata** (di lingkungan pengembangan ini Egress tidak tersedia, jalur gagalnya teruji) |
| Transkripsi per track: lease Redis satu transkriber per room dan per track, normalisasi ke timeline rapat, partial disiarkan, final disimpan sekali (dedupe key), status perlu ditinjau, koreksi menyimpan teks asli, penugasan ulang pembicara manual | Selesai dengan STT mock; **adapter Deepgram belum diuji dengan kunci nyata** |
| Pipeline AI: tunggu flush, finalisasi (urut, dedupe, jeda), chunking, ekstraksi per chunk, validasi bukti, merge, ringkasan, notulen berversi, versi prompt/model/usage tersimpan, susun ulang tanpa mengubah transkrip | Selesai dengan LLM mock; **jalur Claude belum dijalankan dengan kunci nyata** |
| Hasil: tab Ringkasan, Topik, Keputusan (tinjau/ubah), Tindak lanjut (penanggung jawab/tenggat/status), Transkrip (cari, filter, ekspor TXT/JSON/DOCX/PDF), Notulen (ekspor DOCX/PDF/TXT), Rekaman, Peserta | Selesai |
| Riwayat: filter status/pemilik/tanggal, pencarian judul + full-text transkrip (indeks GIN) | Selesai |
| Webhook LiveKit: verifikasi signature, idempotensi berdasarkan event id | Selesai |
| Transactional outbox untuk pemicu AI dan transkripsi | Selesai |
| Audit log (aksi host, akses rekaman, ekspor, koreksi, perubahan izin) | Selesai |
| Uji beban 100/150 peserta, autoscaling worker, observability (OpenTelemetry, metrik), alert | **Belum** (Fase 4) |
| Otomasi retensi/penghapusan data | **Belum**: nilai retensi tersimpan per rapat, penghapusan manual rekaman tersedia |
| Workspace/multi-tenant, admin retensi, integrasi kalender, template notulen organisasi | **Belum** (Fase 5) |

## Keputusan yang perlu Anda tinjau

- **Kebijakan consent (PRD 11.2)**: rapat yang dapat direkam atau ditranskripsi mewajibkan persetujuan untuk masuk; menolak berarti tidak masuk. Rekaman yang dimulai di tengah rapat menampilkan pemberitahuan ke semua peserta, dengan pilihan keluar.
- **Ruang tunggu** berlaku untuk tamu dan akun terdaftar yang belum pernah diterima di rapat itu.
- **Tautan undangan** hanya dapat ditampilkan sekali karena server menyimpan hash-nya. Host dapat membuat tautan baru atau mencabut semua tautan lama.
- **Logo**: belum ada aset resmi; wordmark teks "Zuum." dipakai sebagai placeholder `[LOGO]`.
- Arah desain ada di `DESIGN.md` dan ditulis oleh agen dari brief singkat; ganti sesuai brand Anda.

## Keamanan

TLS diserahkan ke reverse proxy. Yang ditangani aplikasi: hash Argon2id, refresh token httpOnly SameSite=Strict + header CSRF, RBAC di setiap endpoint (`resolveActor` sebagai pengaman IDOR), token LiveKit berumur pendek, signature webhook, redaksi token/sandi/cookie di log, CSP dan header keamanan di nginx, chat/transkrip dirender sebagai teks. Sebelum produksi: pen-test, uji beban, dan pemindaian dependensi (PRD 11.4, 15 Fase 4).
