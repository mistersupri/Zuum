# Zuum

Aplikasi rapat video berbasis web dengan transkrip Bahasa Indonesia real-time per peserta dan notulen berbantuan AI. Dibangun dari PRD "AI Online Meeting" v1.0.

- **Media**: WebRTC lewat LiveKit (SFU). Audio/video tidak pernah melewati API Node.js.
- **Transkrip**: worker bergabung ke room sebagai peserta tersembunyi, berlangganan audio setiap peserta, memotongnya per ucapan (VAD), lalu mengirimnya ke Whisper. Identitas pembicara berasal dari track milik peserta yang terautentikasi, bukan tebakan diarization.
- **AI**: setelah rapat berakhir, transkrip difinalisasi lalu LLM menyusun topik, keputusan, tindak lanjut, ringkasan, dan notulen sebagai keluaran terstruktur yang divalidasi schema. Setiap rujukan ke segmen transkrip diperiksa; item tanpa bukti ditandai "perlu ditinjau".
- **Biaya**: default seluruh stack bisa di-host sendiri tanpa biaya lisensi atau API (lihat bagian Biaya).

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
                   └──── agen transkripsi (subscribe audio) ──> Whisper (self-host)
                                                       └──> Ollama (pipeline AI, self-host)
```

## Menjalankan secara lokal (pengembangan)

Prasyarat: Node 22, PostgreSQL 16, Redis 7, dan `livekit-server` (biner atau Docker).

```bash
cp .env.example .env          # isi JWT_SECRET; tanpa server Whisper/Ollama, pakai STT_PROVIDER=mock dan LLM_PROVIDER=mock
npm install
npm run db:deploy             # menerapkan migrasi ke DATABASE_URL
livekit-server --config infra/livekit.dev.yaml   # terminal terpisah
npm run dev                   # API :4000, worker, web :5173 (Vite mem-proxy /api ke API)
```

Buka http://localhost:5173, daftar akun, lalu klik **Mulai rapat sekarang**.

## Menjalankan dengan Docker Compose

Kedua file compose sudah berisi seluruh konfigurasi (tidak perlu file `.env`). Isinya: Postgres, Valkey, LiveKit, Egress, MinIO (bucket rekaman dibuat otomatis), faster-whisper, Ollama (model diunduh otomatis saat start pertama, beberapa GB), API, worker, dan web di :8080.

**Dari image yang sudah dipublikasikan** (tanpa clone repo):

```bash
# Unduh docker-compose.yml dari aset GitHub Release, atau ambil deploy/docker-compose.yml
docker compose up -d
```

Image yang dipakai: `ghcr.io/mistersupri/zuum-{api,worker,web}:<versi>`. Versinya mengikuti rilis tempat file itu berasal; ganti tanpa mengedit file dengan `ZUUM_VERSION=1.2.3 docker compose up -d`. Bila paket GHCR masih private, jalankan `docker login ghcr.io` dulu.

**Dari source** (repo ini): `docker compose up --build -d`.

Sebelum dipakai di luar komputer sendiri, ubah nilai bertanda `GANTI` di blok **Konfigurasi** di bagian atas file:

| Nilai | Isi dengan |
|---|---|
| `PUBLIC_APP_URL`, `CORS_ORIGINS` | Alamat yang dibuka pengguna, mis. `https://rapat.contoh.id` |
| `LIVEKIT_URL` | Alamat LiveKit dari browser, mis. `wss://media.contoh.id` |
| `node_ip` di `LIVEKIT_CONFIG` | IP publik server, agar peserta dari jaringan lain terhubung |
| `S3_PUBLIC_ENDPOINT` | Alamat MinIO dari browser, untuk memutar rekaman |
| `JWT_SECRET`, secret LiveKit (3 tempat), secret MinIO (3 tempat) | String acak, mis. `openssl rand -base64 48` |

Model Whisper diunduh oleh server Whisper sesuai `WHISPER_MODEL`; ikuti dokumentasi server tersebut bila model perlu diunduh manual.

## Versi dan rilis

Versi mengikuti [Semantic Versioning](https://semver.org) dan hanya ada satu sumber: `version` di `package.json` root. Semua workspace dan versi image di `deploy/docker-compose.yml` diselaraskan oleh skrip, dan CI menolak versi yang tidak konsisten atau bukan semver.

```bash
npm run version:bump -- patch        # 0.1.0 -> 0.1.1   (juga: minor, major, prerelease, atau X.Y.Z)
npm run version:check
```

Alur rilis: naikkan versi dalam pull request, lalu merge ke `main`. Workflow `.github/workflows/publish.yml` kemudian:

1. Menjalankan typecheck, unit test, dan build web.
2. Membangun dan mem-push `zuum-api`, `zuum-worker`, `zuum-web` ke GHCR dengan tag `X.Y.Z`, `X.Y`, `X` (mulai 1.0.0), `latest`, plus `main` dan `sha-<commit>`. Prerelease (mis. `1.0.0-rc.1`) hanya mendapat tag versinya sendiri dan tidak menggeser `latest`.
3. Membuat tag git `vX.Y.Z` dan GitHub Release berisi catatan perubahan serta `docker-compose.yml` siap pakai.

Push ke `main` tanpa kenaikan versi hanya memperbarui tag `main` dan `sha-<commit>`. Tag `v*` yang di-push manual harus sama persis dengan versi di `package.json`; bila tidak, workflow gagal. Setiap image membawa versinya: label OCI `org.opencontainers.image.version`, variabel `APP_VERSION`, `GET /healthz` pada API, dan menu pengguna di aplikasi web.

### Variabel penting

| Variabel | Fungsi |
|---|---|
| `JWT_SECRET` | Kunci tanda tangan token akses/tamu, minimal 32 karakter |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Koneksi ke LiveKit; kunci yang sama memverifikasi webhook |
| `STT_PROVIDER`, `WHISPER_BASE_URL`, `WHISPER_MODEL`, `STT_LANGUAGE=id` | Transkripsi. Default `whisper` (server OpenAI-compatible: faster-whisper, whisper.cpp, atau API Whisper ter-host). `deepgram` tersedia sebagai opsi berbayar. `mock` hanya untuk uji |
| `WHISPER_PARTIAL_INTERVAL_MS` | Teks parsial saat orang masih berbicara. `0` (default) mematikannya untuk menghemat komputasi |
| `LLM_PROVIDER`, `OLLAMA_MODEL` | AI notulen. Default `ollama` (model terbuka self-host, default `qwen2.5:7b-instruct`). `anthropic` memakai Claude, default `claude-haiku-5-5` |
| `S3_*`, `S3_PUBLIC_ENDPOINT` | Penyimpanan rekaman (MinIO bawaan, Cloudflare R2, S3). `S3_PUBLIC_ENDPOINT` dipakai untuk tautan putar bila endpoint internal tidak dapat dijangkau browser |
| `RECORD_INDIVIDUAL_AUDIO` | Rekam juga audio per peserta selama perekaman |
| `REQUIRE_EMAIL_VERIFICATION`, `SMTP_URL` | Verifikasi email dan email reset sandi. Di development, isi email dicetak ke log API |

## Biaya

Semua komponen default bersifat open source dan dapat dijalankan di server sendiri, jadi biaya yang tersisa hanya server.

| Komponen | Default (gratis) | Opsi berbayar/hosting bila perlu |
|---|---|---|
| Media | LiveKit self-host (Apache-2.0) + Egress | LiveKit Cloud |
| Transkripsi | faster-whisper via server OpenAI-compatible | API Whisper ter-host (`WHISPER_BASE_URL` + `WHISPER_API_KEY`), Deepgram |
| AI notulen | Ollama + model terbuka | Claude (`LLM_PROVIDER=anthropic`, default Haiku 5.5, tier termurah) |
| Database | PostgreSQL self-host | Postgres terkelola |
| Antrean/pubsub | Valkey (fork Redis berlisensi BSD) | Redis terkelola |
| Rekaman | MinIO | Cloudflare R2, S3 |
| Email | SMTP apa pun | |

Hal yang perlu diketahui sebelum memilih default gratis:

- **Whisper bukan model streaming.** Teks final muncul setelah satu ucapan selesai ditambah waktu inferensi, jadi target PRD 6.3 (parsial ≤ 2,5 detik) sulit dicapai di CPU. Untuk mendekatinya: GPU, model lebih kecil, atau `WHISPER_PARTIAL_INTERVAL_MS` (menambah beban komputasi). Deepgram tetap tersedia bila latensi rendah wajib.
- **Kebutuhan server.** Whisper dan model 7B di CPU akan lambat untuk banyak peserta sekaligus; kapasitas harus diukur dengan uji beban (PRD 5.4). GPU tunggal biasanya cukup untuk keduanya.
- **Kualitas notulen.** Model lokal 7B lebih lemah daripada Claude dalam mengikuti aturan bukti dan Bahasa Indonesia formal. Validasi schema dan bukti tetap berjalan, dan keluaran yang tidak valid diminta diperbaiki sekali sebelum job gagal, tetapi tinjau hasilnya. `LLM_PROVIDER=anthropic` dengan Haiku adalah opsi murah bila kualitas kurang.
- Whisper diketahui menghasilkan kalimat karangan pada audio hening. VAD membuang hening sebelum dikirim, segmen dengan `no_speech_prob` tinggi dibuang, dan frasa halusinasi yang umum ("Terima kasih telah menonton") disaring.

## Pengujian

```bash
npm test                       # unit test: guardrail AI, chunking, matriks izin, timestamp, VAD/WAV, adapter Whisper & Ollama
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
| Transkripsi per track: lease Redis satu transkriber per room dan per track, normalisasi ke timeline rapat, partial disiarkan, final disimpan sekali (dedupe key), status perlu ditinjau, koreksi menyimpan teks asli, penugasan ulang pembicara manual | Selesai. Adapter Whisper diuji end-to-end lewat LiveKit terhadap server tiruan berprotokol OpenAI; **belum dijalankan dengan model Whisper sungguhan** (unduhan model diblokir di lingkungan pengembangan ini). Deepgram belum diuji dengan kunci nyata |
| Pipeline AI: tunggu flush, finalisasi (urut, dedupe, jeda), chunking, ekstraksi per chunk, validasi bukti, merge, ringkasan, notulen berversi, versi prompt/model/usage tersimpan, susun ulang tanpa mengubah transkrip | Selesai. Provider Ollama diuji end-to-end terhadap server tiruan berprotokol Ollama; **belum dijalankan dengan model sungguhan**, begitu juga jalur Claude |
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
