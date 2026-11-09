# Zuum: arah desain

> Arah ini ditulis oleh agen dari brief pengguna ("menarik dan user friendly") dan PRD.
> Arah buatan agen cenderung jatuh ke selera default AI. Ganti bagian mana pun
> dengan keputusan brand Anda sendiri; kode membaca semuanya dari token di
> `apps/web/src/styles.css`.

## Design Read

Reading this as: aplikasi kerja (ruang rapat + arsip dokumen) untuk tim kantor
dan organisasi di Indonesia, dengan bahasa visual "kertas notulen dan tinta":
permukaan hangat untuk dokumen, ruang rapat gelap agar video menonjol.

Dial: ENERGY 2 / RHYTHM 2 / MOTION 2

- ENERGY 2: tenang dan profesional, satu titik fokus per layar.
- RHYTHM 2: halaman konsisten, dengan beberapa jeda (dashboard asimetris, halaman hasil pakai serif dokumen).
- MOTION 2: transisi fungsional saja (panel, dialog, toast, segmen transkrip masuk). Tidak ada animasi scroll.

## Identitas

- Nama ditulis sebagai wordmark teks "Zuum" (belum ada logo resmi: `[LOGO]` menunggu aset dari pemilik).
- Motif identitas: **cincin kunyit** penanda siapa yang sedang berbicara, dipakai di
  ubin video, daftar peserta, dan baris transkrip parsial. Satu gestur yang sama di tiga tempat.
- Baris transkrip: cap waktu angka tabular + chip inisial pembicara + teks. Pola ini juga dipakai di ekspor.

## Warna (alasan satu baris per warna)

| Token | Terang | Gelap | Alasan |
|---|---|---|---|
| paper | `#F7F5EF` | `#121615` | Latar hangat seperti kertas notulen; mengurangi silau dibanding putih murni. |
| ink | `#1C1F1E` | `#ECEAE4` | Teks utama, kontras tinggi di atas paper. |
| teal (inti) | `#0E5E56` | `#5FC4B4` | Warna aksi utama; hijau-biru tua terbaca serius tanpa ikut tren biru-ungu. |
| kunyit (aksen) | `#E8A317` | `#F0B43A` | Hanya untuk "sedang berbicara" dan item yang butuh perhatian. Tidak dipakai untuk teks di atas latar terang. |
| merah rekam | `#B42F25` | `#FF6B5E` | Hanya indikator REC dan aksi destruktif; konvensi universal perekaman. |

Warna chip pembicara (6 rona redup) adalah encoding data untuk membedakan orang, bukan bagian palet.

## Tipografi

- **Plus Jakarta Sans** untuk UI: dirancang untuk identitas kota Jakarta, bukaan huruf lebar sehingga terbaca di ukuran kecil, cocok untuk produk berbahasa Indonesia.
- **Newsreader** untuk isi dokumen (ringkasan, notulen): notulen adalah catatan resmi; serif baca memisahkan "dokumen" dari "kontrol".
- Angka waktu memakai `tabular-nums` agar kolom cap waktu rata.

## Bentuk, ruang, elevasi

- Radius: kontrol 10px, kartu 14px, kapsul hanya untuk status nyata (LIVE, REC, status proses).
- Bayangan hanya untuk elemen yang mengambang (menu, dialog, toast). Kartu memakai garis 1px.
- Spasi berbasis 4px; jarak antar-bagian lebih besar dari jarak di dalam bagian.

## Ikon

Phosphor (bobot regular/fill): kontrol rapat butuh glyph yang langsung dikenali (mikrofon, kamera, berbagi layar), dan goresannya selaras dengan ketebalan Plus Jakarta Sans.

## Gerak

Mengikuti prinsip Emil Kowalski: hanya `transform`/`opacity`, ease-out kuat
`cubic-bezier(0.23, 1, 0.32, 1)`, 150 sampai 250 ms, tombol `scale(0.97)` saat ditekan,
tanpa animasi untuk aksi keyboard berulang, dan `prefers-reduced-motion` dihormati.
