# AgentRouter Daily Auto-Claim ($25) via Cloudflare Workers

Bot gratis yang otomatis **login & klaim reward $25 harian** di [agentrouter.org](https://agentrouter.org) — berjalan di **Cloudflare Workers** (cron trigger) memakai **Browser Run** untuk menembus WAF, dengan **dashboard web** untuk memantau saldo & riwayat. Login memakai **Email/Username + Password** AgentRouter (tanpa GitHub).

> **Kenapa butuh Browser Run?** WAF Aliyun milik AgentRouter memblokir request `fetch()` dari IP datacenter Cloudflare (buktinya: `/api/user/self` membalas HTML challenge `aliyun_waf_aa`). Browser Run menjalankan Chromium sungguhan sehingga challenge JS WAF terlewati — seperti browsing manual. Free tier: **10 menit browser/hari** — alur di bawah dirancang supaya hari-hari normal hanya memakai ±30 detik.

---

## ⚡ Quick Start (TL;DR)

1. Pastikan akun AgentRouter Anda punya password (lihat [bagian 1](#1-persiapan-akun--password)).
2. Simpan kredensial: `npx wrangler secret put AGENTROUTER_EMAIL` lalu `npx wrangler secret put AGENTROUTER_PASSWORD`
3. Deploy: `bun run deploy`
4. Selesai → otomatis klaim **setiap hari 08:00 WIB** (+ retry 14:00 WIB). Pantau di dashboard worker Anda.

---

## Fitur Utama

- ⏰ **Cron otomatis + retry**: klaim berjalan sendiri setiap hari `08:00 WIB`; bila gagal, diulang `14:00 WIB`. Setiap eksekusi dimulai dengan **cek murah tanpa browser** — kalau reward hari ini sudah aktif, langsung skip (kuota Browser Run tidak terpakai).
- 🔑 **Sesi tersimpan otomatis (Durable Object)**: setelah login sukses, cookie sesi AgentRouter disimpan. Hari berikutnya cukup *quick check* 1 halaman — **tanpa login ulang** selama sesi masih hidup.
- ✅ **Verifikasi reward nyata**: sukses tidak lagi sekadar "API membalas data". Bot membandingkan `quota` sebelum vs sesudah login — kenaikan ≥ $25 ditandai **TERVERIFIKASI** di pesan & dashboard (`+$25.00` vs `+$25.00*`).
- 🌐 **Browser Run (Playwright)**: saat sesi habis, re-login via form Email/Password di Chromium sungguhan → lolos WAF Aliyun. Gagal cepat + pesan jelas untuk kredensial salah dan kuota browser habis (429).
- 📊 **Dashboard monochrome**: saldo terkini, akun, status hari ini, riwayat klaim (pagination `< 1/3 >`, 5 baris/halaman; di mobile jadi kartu responsif).
- 🔒 **Proteksi endpoint**: bila secret `TRIGGER_AUTH_KEY` disetel, semua endpoint mahal/sensitif (`/trigger`, `/debug-browser`, `/clean-history`, `/api/history`, `/debug`) wajib `?key=...`.
- 🧱 **Lock anti-dobel**: cron & trigger manual tidak bisa berjalan bersamaan (lock otomatis 10 menit di Durable Object).
- 🆓 **100% gratis**: Workers Free Tier + free tier Browser Run.

---

## 1. Persiapan: Akun & Password

Bot login ke AgentRouter memakai **Email/Username + Password** — bukan lagi OAuth GitHub.

- **Akun sudah punya password?** Siapkan email/username + password-nya, lalu lanjut ke bagian 2.
- **Akun hanya pernah login via GitHub?** Buka `https://agentrouter.org/login` → klik **"Sign in with Email or Username"** → **"Forgot password?"** → masukkan email akun Anda → ikuti email reset untuk membuat password pertama.
- Gunakan password yang kuat dan khusus untuk situs ini — password disimpan sebagai Cloudflare Secret (terenkripsi), tidak pernah masuk kode/log.

> ⚠️ **Jika kredensial berubah/gagal**, bot akan gagal dengan pesan jelas — cukup perbarui secret (lihat [Troubleshooting](#5-troubleshooting)).

---

## 2. Setup & Deploy

### Langkah 1 — Clone & install
```bash
git clone https://github.com/bismawy/agentrouter-daily.git
cd agentrouter-daily
bun install        # atau: npm install
```

### Langkah 2 — Login Cloudflare
```bash
npx wrangler login
```

### Langkah 3 — Simpan secret
```bash
# Wajib: kredensial login AgentRouter (dari bagian 1)
npx wrangler secret put AGENTROUTER_EMAIL
npx wrangler secret put AGENTROUTER_PASSWORD

# Sangat disarankan: kunci proteksi endpoint manual
npx wrangler secret put TRIGGER_AUTH_KEY

# Opsional: cookie sesi agentrouter.org (cadangan baca saldo)
npx wrangler secret put AGENTROUTER_COOKIE
```

### Langkah 4 — Deploy
```bash
bun run deploy     # atau: npm run deploy
```

Selesai → Cloudflare menampilkan URL worker Anda: `https://agentrouter-daily.<subdomain>.workers.dev`

> Binding `[browser]` dan Durable Object `[STATE]` sudah dikonfigurasi di `wrangler.toml` — **semua dibuat otomatis saat deploy**, tanpa setup tambahan. Pastikan paket `@cloudflare/playwright` terinstall (`bun install`).

---

## 3. Cara Kerja Alur Klaim

```
Cron 08:00 / 14:00 WIB
│
├─ Cek murah (tanpa browser): last_login hari ini sudah tercatat? → SELESAI (skip)
│
├─ Ada sesi tersimpan? ── QUICK CHECK (1 halaman browser, ±30 dtk)
│    ├─ last_login hari ini → reward sudah aktif → SELESAI ✅
│    ├─ sesi hidup, belum login hari ini → lanjut login penuh (baseline quota segar)
│    └─ sesi mati → hapus sesi, lanjut login penuh
│
└─ LOGIN PENUH (Browser Run): form Email/Password di /login →
     baca saldo → VERIFIKASI naik ≥ $25 →
     simpan sesi baru untuk besok → (fallback Pure HTTP bila browser gagal)
```

- **Verifikasi**: `+$25.00` = kenaikan saldo terukur langsung; `+$25.00*` = login hari ini aktif tapi kenaikan tidak terukur (mis. reward sudah diklaim sebelumnya hari itu).
- **Login manual Anda di agentrouter.org tetap dihitung** — kalau Anda sudah login sendiri hari itu, bot mendeteksinya via quick check dan tidak membakar kuota browser.

## Endpoint

Buka URL worker Anda: `https://agentrouter-daily.<subdomain>.workers.dev/`

| Endpoint | Fungsi | Key? |
|---|---|---|
| `/` | Dashboard: saldo, akun, status hari ini, riwayat klaim | — |
| `/health` | Cek status worker & jadwal cron | — |
| `/trigger?notify=false` | Jalankan klaim manual (tes sekarang) | 🔒 |
| `/api/history` | Riwayat klaim (JSON) | 🔒 |
| `/debug` | Diagnosa koneksi HTTP (tanpa bocorkan secret) | 🔒 |
| `/debug-browser` | Diagnosa alur browser step-by-step ⚠️ *habiskan kuota Browser Run* | 🔒 |
| `/clean-history` | Kosongkan riwayat log (sesi & snapshot tetap tersimpan) | 🔒 |

🔒 = bila `TRIGGER_AUTH_KEY` disetel, tambahkan `?key=<kunci>` atau header `x-auth-key`.

> ⚠️ **Hemat kuota Browser Run (10 menit/hari).** Quick check hemat kuota, tapi login penuh + `/debug-browser` tetap mahal. Dashboard bisa dibuka kapan saja tanpa memakai browser.

---

## 4. Konfigurasi Jadwal Cron (Opsional)

Jadwal default ada di `wrangler.toml`:
```toml
[triggers]
crons = ["0 1 * * *", "0 7 * * *"]   # 08:00 & 14:00 WIB
```

> ⚠️ **Workers Free membatasi 5 cron trigger per akun** (semua worker dijumlahkan). Worker ini memakai 2 slot. Kalau deploy gagal dengan error `10072`, kurangi jadwal di atas atau hapus cron dari worker lain di akun Anda.

Waktu lain yang umum:
| Waktu (WIB) | Cron (UTC) |
|---|---|
| 00:00 | `"0 17 * * *"` |
| 07:00 | `"0 0 * * *"` |
| 12:00 | `"0 5 * * *"` |

Setelah mengubah, deploy ulang: `bun run deploy`. Eksekusi tambahan aman — bila reward hari itu sudah aktif, cron langsung skip tanpa memakai browser.

---

## 5. Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| **Pesan "AGENTROUTER_EMAIL / AGENTROUTER_PASSWORD belum dikonfigurasi"** | Secret belum di-set | Setel kedua secret: `npx wrangler secret put AGENTROUTER_EMAIL` + `npx wrangler secret put AGENTROUTER_PASSWORD` |
| **Pesan "Login ditolak AgentRouter"** | Email/password salah atau berubah | Tes login manual di agentrouter.org → perbarui secret yang salah |
| **Pesan "Kuota Browser Run habis (429)"** | Free tier 10 menit/hari terpakai (spam `/trigger`, `/debug-browser`, atau login berulang) | Tunggu reset 00:00 UTC (07:00 WIB); retry cron otomatis akan mencoba lagi |
| **`+$25.00*` (berhasil tapi tidak terverifikasi)** | Reward hari itu sudah diklaim sebelumnya (login manual / run tadi) | Normal — tidak perlu tindakan |
| **Dashboard "Belum Diklaim" padahal klaim sukses** | Sebelumnya riwayat disimpan di cache per-datacenter (bug lama); kini di Durable Object | Deploy versi baru; klik "Klaim Sekarang" sekali untuk sinkron |
| **Error `Invalid cookie fields` saat inject** | Karakter aneh/newline dari hasil copy | Sudah ditangani otomatis (sanitasi + skip cookie invalid) |
| **Respons `/debug` berisi `aliyun_waf_aa`** | WAF memblokir pure HTTP dari Worker — **normal** | Browser Run yang menanganinya; pastikan binding `[browser]` ada & kuota belum habis |
| **Klaim gagal tapi tidak ada error jelas** | Lihat jalur error | Cek `/debug-browser` (step-by-step) atau `npx wrangler tail` saat trigger |

---

## 6. Struktur Proyek

```
agentrouter-daily/
├── src/
│   ├── index.ts          # Entry: routing, cron retry, lock, orkestrasi quick-check → login email/password
│   ├── browser-claim.ts  # Browser Run: quick-check sesi, login form Email/Password, fail-fast
│   ├── agentrouter.ts    # Pure HTTP login (fallback) + util cookie & verifikasi reward
│   ├── state.ts          # Durable Object StateStore: sesi, snapshot, riwayat, lock
│   ├── dashboard.ts      # Render dashboard (tabel/kartu responsif + pagination)
│   ├── history.ts        # Riwayat klaim (tersimpan di Durable Object)
│   ├── notifier.ts       # Notifikasi Telegram/Discord (opsional)
│   └── types.ts          # Tipe data & interface env
├── wrangler.toml         # Konfigurasi worker, [browser], [durable_objects], cron
└── package.json
```

---

## 7. Keamanan & Privasi

- **`AGENTROUTER_EMAIL` & `AGENTROUTER_PASSWORD` adalah kredensial pribadi.** Simpan hanya sebagai Cloudflare Secret (terenkripsi at-rest, tidak tampil setelah disimpan) — jangan pernah tulis di kode, README, atau commit. Tidak pernah dicatat ke log.
- **Scope terbatas**: berbeda dari cookie GitHub yang membuka seluruh akun GitHub, kredensial ini hanya berlaku untuk agentrouter.org — bocor pun dampaknya jauh lebih kecil.
- **Sesi AgentRouter tersimpan di Durable Object** worker Anda sendiri (tidak keluar dari akun Cloudflare Anda) sehingga hari berikutnya tidak perlu login dari nol.
- Setel `TRIGGER_AUTH_KEY` agar orang lain yang menemukan URL worker tidak bisa memicu klaim / membakar kuota `/debug-browser`.
- `.env`, `.env.*`, dan `.dev.vars` sudah masuk `.gitignore` — tidak akan pernah ter-commit.
- Jika password bocor/terbagi: segera ganti password di agentrouter.org, lalu perbarui secret.
- Repo ini **tidak berisi kredensial asli** — yang ada hanya placeholder contoh.
