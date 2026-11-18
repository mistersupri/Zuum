# PRD Zuum: rapat video, transkrip, dan notulen AI

Nov 18, 2026 · @Ahmad Supriyanto

Zuum adalah aplikasi rapat video berbasis web dengan transkrip Bahasa Indonesia per peserta dan notulen berbantuan AI. Dokumen ini mencatat fitur yang sudah dibangun, batasannya, dan arah migrasi media ke Cloudflare RealtimeKit.

## Ringkasan

Zuum membuat rapat video dari browser, mencatat transkrip Bahasa Indonesia per peserta selama rapat, lalu menyusun ringkasan, keputusan, tindak lanjut, dan notulen setelah rapat berakhir. Target produk adalah 100 peserta atau lebih per rapat.

Backend, web, dan worker sudah dibangun dan diuji end-to-end dengan LiveKit lokal. Rilis terakhir adalah v0.1.1 di GitHub Releases. Migrasi media ke Cloudflare RealtimeKit sedang berjalan: klien REST dan verifikasi webhook sudah ada, tetapi belum dipasang ke alur rapat.

## Fitur

Status per 18 November 2026. "Diuji" berarti dijalankan di browser atau lewat API di lingkungan pengembangan.

| Area | Fitur | Status | Catatan |
| --- | --- | --- | --- |
| Akun | Daftar, masuk, lupa dan reset sandi, profil, zona waktu | Diuji | Verifikasi email opsional |
| Rapat | Judul, agenda, jadwal, kapasitas, kode sandi, ruang tunggu, tamu | Diuji | Kapasitas default 150 |
| Undangan | Token acak 256-bit, hanya hash disimpan, kedaluwarsa, batas pakai, cabut, rotasi | Diuji | Tautan hanya bisa ditampilkan sekali |
| Bergabung | Validasi status, undangan, kode sandi, kunci, kapasitas; persetujuan dicatat | Diuji | Token media berumur 10 menit |
| Kontrol host | Terima dan tolak, bisukan, keluarkan, kunci rapat, co-host | Diuji | Co-host sesuai pengaturan rapat |
| Ruang rapat | Grid berhalaman, pembicara aktif, berbagi layar, chat, daftar peserta | Diuji | Diuji dengan 2 peserta, belum 100+ |
| Transkrip langsung | Teks per peserta, koreksi dengan teks asli, tandai perlu ditinjau | Diuji dengan STT tiruan | Model Whisper atau Deepgram belum diuji |
| Rekaman | Komposit dan audio per peserta lewat LiveKit Egress | Kode selesai | Egress sungguhan belum tersedia saat pengujian |
| Notulen AI | Finalisasi, ekstraksi dengan rujukan bukti, ringkasan, notulen berversi | Diuji dengan LLM tiruan | Model Ollama dan Claude belum diuji |
| Hasil | Ringkasan, topik, keputusan, tindak lanjut, transkrip, notulen, rekaman, peserta | Diuji | Keputusan dan tindak lanjut bisa diubah |
| Ekspor | Transkrip TXT, JSON, DOCX, PDF; notulen DOCX, PDF, TXT | Diuji | |
| Riwayat | Filter status, pemilik, tanggal; cari judul dan isi transkrip | Diuji | Pencarian full-text dengan indeks GIN |
| Audit | Aksi host, akses rekaman, ekspor, koreksi, perubahan izin | Diuji | |
| Tampilan | Tema terang dan gelap, tata letak mobile 360 px | Diuji | Kontras WCAG AA diperiksa |

## Peran dan izin

Izin ditegakkan di server pada setiap endpoint. Browser hanya memakai matriks yang sama untuk menyembunyikan tombol yang tidak bisa dipakai. Co-host memakai izin yang diatur per rapat.

| Aksi | Owner dan host | Co-host | Peserta | Tamu |
| --- | --- | --- | --- | --- |
| Masuk rapat | Ya | Ya | Ya | Jika tautan valid |
| Bisukan diri sendiri | Ya | Ya | Ya | Ya |
| Bisukan peserta lain | Ya | Default ya, bisa dimatikan | Tidak | Tidak |
| Keluarkan peserta | Ya | Default tidak, bisa diaktifkan | Tidak | Tidak |
| Mulai dan hentikan rekaman | Ya | Default tidak, bisa diaktifkan | Tidak | Tidak |
| Terima atau tolak dari ruang tunggu, kunci rapat | Ya | Ya | Tidak | Tidak |
| Lihat transkrip langsung | Ya | Ya | Sesuai pengaturan | Sesuai pengaturan |
| Unduh hasil rapat | Ya | Sesuai pengaturan | Default tidak | Tidak |
| Akhiri rapat untuk semua | Ya | Tidak | Tidak | Tidak |

Owner dan host memiliki izin yang sama di aplikasi, tetapi tercatat sebagai peran terpisah. Host tidak bisa dikeluarkan oleh co-host, dan peserta yang sudah dikeluarkan tidak bisa masuk lagi dengan tautan yang sama.

## Alur utama

Alur ini berlaku pada implementasi LiveKit saat ini.

1. Host membuat rapat dengan judul, agenda, dan pengaturan, atau langsung memulai rapat instan. Sistem mengembalikan tautan undangan.
2. Peserta membuka tautan. Tamu mengisi nama. Semua peserta menyetujui pemberitahuan rekaman dan transkripsi, dan persetujuan itu dicatat.
3. Jika ruang tunggu aktif, peserta menunggu. Host menerima atau menolak dari panel peserta.
4. Setelah diterima, server memberi token media berumur 10 menit yang hanya berlaku untuk satu room.
5. Peserta mempublikasikan mikrofon dan kamera. Agen transkripsi berlangganan audio setiap peserta, memotongnya per ucapan, lalu mengirimkannya ke layanan STT.
6. Host memulai rekaman. Pemberitahuan ditampilkan ke semua peserta, dan indikator REC tampil selama rekaman berjalan.
7. Host mengakhiri rapat untuk semua. Peserta diputus, status transkrip menjadi final, dan pipeline AI diantrikan.
8. Pipeline AI membuat ringkasan, topik, keputusan, tindak lanjut, dan notulen. Item tanpa bukti di transkrip ditandai perlu ditinjau.
9. Host atau peserta yang berizin meninjau hasil, mengubah keputusan atau tindak lanjut, lalu mengunduh notulen dan transkrip.

## Arsitektur dan migrasi

Media rapat saat ini berjalan di LiveKit. Migrasi ke Cloudflare RealtimeKit dilakukan agar server di rumah yang berada di balik CGNAT tidak perlu dapat diakses dari internet. Cloudflare TURN saja tidak cukup, karena server LiveKit tetap perlu alamat yang bisa dijangkau.

| Komponen | Saat ini (LiveKit) | Tujuan (RealtimeKit) | Status |
| --- | --- | --- | --- |
| Media rapat | LiveKit server, perlu IP publik atau tunnel | RealtimeKit milik Cloudflare | Belum dipasang |
| Token peserta | Dibuat API dengan access token LiveKit | Dibuat lewat addParticipant, token dikembalikan Cloudflare | Klien sudah ada |
| Event peserta dan track | Webhook LiveKit, diverifikasi signature | Webhook RealtimeKit (rtk-signature, RSA-SHA256) | Verifikasi sudah ada |
| Transkrip langsung | Worker berlangganan audio tiap track, STT Whisper atau Deepgram | Teks dari SDK di browser, disimpan lewat API kita | Belum dibuat |
| Transkrip final | Pipeline dari segmen yang disimpan | Event meeting.transcript dari Workers AI lewat webhook | Belum dibuat |
| Rekaman | LiveKit Egress ke RustFS | Rekaman RealtimeKit di R2, file disimpan 7 hari, lalu dipindah ke RustFS | Belum dibuat |
| Relay jaringan | Cloudflare TURN, opsional | Termasuk di RealtimeKit, perlu diverifikasi | Perlu diverifikasi |
| Pipeline AI | Dari segmen transkrip | Tetap sama, memakai transkrip yang disimpan | Tidak berubah |

Keputusan yang sudah diambil: transkrip langsung dikirim dari browser ke API dan disimpan, dengan validasi id peserta. Kredensial RealtimeKit disimpan di server saja.

## Konfigurasi

Nilai di compose yang bertanda GANTI wajib diubah sebelum dipakai di luar komputer pengembang. Di deployment, semua variabel ditulis langsung di file compose, tanpa file `.env`.

| Variabel | Wajib | Default | Fungsi |
| --- | --- | --- | --- |
| `JWT_SECRET` | Ya, GANTI | Tidak ada | Kunci penandatangan token akses dan tamu, minimal 32 karakter |
| `PUBLIC_APP_URL` | Ya | Tidak ada | Alamat yang dibuka pengguna, dipakai untuk tautan undangan |
| `DATABASE_URL` | Ya | Tidak ada | PostgreSQL |
| `REDIS_URL` | Ya | redis://localhost:6379 | Antrean BullMQ, pub/sub, dan rate limit |
| `LIVEKIT_URL` | Ya | ws://localhost:7880 | Alamat LiveKit untuk browser. Bisa berupa path seperti `/livekit` |
| `LIVEKIT_API_URL` | Jika LIVEKIT_URL berupa path | Tidak ada | Alamat LiveKit untuk API |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Ya, secret GANTI | Tidak ada | Kunci LiveKit, juga untuk memverifikasi webhook |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | Untuk rekaman | Tidak ada | Endpoint penyimpanan dari server, dan dari browser untuk memutar rekaman |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Untuk rekaman, secret GANTI | zuum-recordings | Bucket dibuat otomatis saat API start |
| `STT_PROVIDER` | Tidak | whisper | `whisper`, `deepgram`, atau `mock` untuk uji |
| `WHISPER_BASE_URL`, `WHISPER_MODEL` | Jika whisper | http://localhost:8000/v1, Systran/faster-whisper-small | Server OpenAI-compatible |
| `DEEPGRAM_API_KEY` | Jika deepgram | Tidak ada | Opsi berbayar |
| `LLM_PROVIDER` | Tidak | ollama | `ollama`, `anthropic`, atau `mock` untuk uji |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Jika ollama | http://localhost:11434, qwen2.5:7b-instruct | Model AI lokal |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Jika anthropic | Tidak ada, claude-haiku-5-5 | Claude |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN` | Tidak | Kosong | Cloudflare TURN untuk browser. Kosong berarti nonaktif |
| `RECORD_INDIVIDUAL_AUDIO` | Tidak | false | Rekam juga audio per peserta |
| `REQUIRE_EMAIL_VERIFICATION`, `SMTP_URL` | Tidak | false, kosong | Verifikasi email dan email reset sandi |

Variabel RealtimeKit (`REALTIMEKIT_ORG_ID`, `REALTIMEKIT_APP_ID`, `REALTIMEKIT_API_KEY`) akan ditambahkan saat migrasi dipasang.

## Status verifikasi

Yang sudah diuji dan yang belum. Belum diuji berarti belum pernah dijalankan dengan layanan sungguhan.

| Pemeriksaan | Hasil | Catatan |
| --- | --- | --- |
| Unit test shared, API, worker | Lulus: 13, 25, dan 11 tes | `npm test` |
| E2E dua browser (daftar sampai ekspor) | Lulus | LiveKit lokal, STT dan LLM tiruan |
| Navigasi keyboard | Lulus | Tab, Escape, dan panah di tab |
| Kontras teks WCAG AA | Lulus | Terendah 5,05 terang, 5,45 gelap |
| Overflow horizontal di 360 px | Tidak ada | Semua halaman |
| Build image Docker | Belum | Tidak ada Docker daemon di pengembangan; CI PR akan membangun |
| `docker compose up` dari deploy | Belum | |
| Model Whisper sungguhan | Belum | Adapter diuji dengan server tiruan |
| Model Ollama sungguhan | Belum | Adapter diuji dengan server tiruan |
| Claude sebagai LLM | Belum | |
| Rekaman lewat LiveKit Egress | Belum | Jalur gagal sudah diuji |
| RustFS sebagai penyimpanan | Belum | Nama variabel diambil dari skrip image |
| Cloudflare TURN | Belum | Diuji dengan Cloudflare tiruan |
| RealtimeKit REST dan webhook | Unit test | Dengan mock dan kunci RSA buatan, belum ke Cloudflare |
| Beban 100+ peserta | Belum | Target PRD, belum ada uji |

## Risiko dan pertanyaan terbuka

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Batas peserta RealtimeKit belum terverifikasi | Target 100+ peserta tidak bisa dipenuhi | Tanyakan ke Cloudflare, lalu uji beban sebelum migrasi penuh |
| Transkrip langsung dari browser bisa dimanipulasi | Teks palsu tersimpan | Validasi id peserta, catat pengirim, jadikan transkrip final dari webhook sumber resmi |
| Biaya per menit peserta dan transkripsi | Tagihan naik saat pemakaian tinggi | Pantau pemakaian, batasi durasi, catat biaya per rapat |
| Server LiveKit di rumah di balik CGNAT | Media tidak jalan tanpa IP publik | Migrasi ke RealtimeKit, atau LiveKit Cloud, atau VPS dengan IP publik |
| STT dan LLM lokal kurang akurat dari layanan besar | Transkrip dan notulen kurang tepat | Uji dengan rapat sungguhan yang disetujui pemiliknya (PRD bagian 17) |
| Rekaman RealtimeKit ada di server Cloudflare 7 hari | Data tertahan di luar penyimpanan kita | Unduh dan pindahkan ke RustFS segera setelah siap |
| Persetujuan dan kebijakan privasi belum ditinjau hukum | Risiko kepatuhan saat rilis luas | Tinjauan hukum sebelum rilis (PRD bagian 11.2) |
| Tidak ada otomasi retensi | Data menumpuk melewati masa simpan | Dijadwalkan di fase 4 |

Pertanyaan yang perlu dijawab pemilik produk:

- Apakah satu rapat wajib mendukung 100 peserta sejak rilis pertama, atau cukup puluhan dulu?
- Apakah transkrip langsung dari browser boleh dianggap sumber utama, atau hanya transkrip final dari webhook?
- Apakah LiveKit Cloud diterima sebagai opsi jika RealtimeKit tidak memenuhi target?
- Berapa anggaran bulanan untuk media, transkripsi, dan AI?
- Apakah peserta yang menolak rekaman boleh tetap masuk tanpa direkam, atau ditolak masuk?

## Sumber

Dibuka 18 November 2026. Halaman `developers.cloudflare.com` diblokir dari lingkungan pengembangan, jadi dokumen diambil dari repositori sumbernya di GitHub.

**Cloudflare Realtime TURN**
- [Generate credentials](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/turn/generate-credentials.mdx)
- [FAQ](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/turn/faq.mdx)

**Cloudflare Realtime SFU**
- [Ikhtisar](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/sfu/index.mdx)
- [Sessions dan tracks](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/sfu/concepts/sessions-tracks.mdx)
- [Pricing](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/sfu/platform/pricing.mdx) dan [limits](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/sfu/platform/limits.mdx)
- [WebSocket adapter](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/sfu/features/media-transport-adapters/websocket-adapter.mdx)

**RealtimeKit**
- [Ikhtisar](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/realtimekit/index.mdx)
- [Pricing](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/realtimekit/platform/pricing.mdx) dan [limits](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/realtimekit/platform/limits.mdx)
- [Transkripsi](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/realtimekit/ai/transcription.mdx)
- [Panduan rekaman](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/realtimekit/recording-guide/index.mdx)
- [Webhook](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/realtime/realtimekit/webhooks.mdx)

**Spesifikasi API**
- [OpenAPI Cloudflare](https://github.com/cloudflare/api-schemas/blob/main/openapi.json), path `realtime/kit`

**Riwayat pengembangan**
- [PR #1, aplikasi awal](https://github.com/mistersupri/Zuum/pull/1), [PR #2, versioning dan compose](https://github.com/mistersupri/Zuum/pull/2), [PR #3, RustFS](https://github.com/mistersupri/Zuum/pull/3)
