# AgentRouter Daily Auto-Claim ($25) via Cloudflare Workers

Sistem otomatis untuk login dan klaim reward $25 harian di [agentrouter.org](https://agentrouter.org) menggunakan **Cloudflare Workers Cron Triggers** dan dilengkapi **Web Dashboard Monochrome Minimalis**.

---

## Fitur Utama

- ⏰ **Scheduled Cron Trigger**: Berjalan otomatis setiap hari pukul `01:00 UTC` / `08:00 WIB`.
- 📊 **Web Dashboard Monochrome**: UI minimalis menggunakan font **Geist Mono** untuk memantau status bot, saldo terkini, dan tabel riwayat klaim.
- ⚡ **Tombol Klaim Instan**: Tombol interaktif `[ Klaim Sekarang ]` dengan proteksi anti-spam (maksimal 1 kali klaim per hari).
- 🍪 **Auto User Extraction**: Otomatis mendeteksi identitas & ID user dari cookie session.
- 🆓 **100% Serverless & Gratis**: Dijalankan di atas Cloudflare Workers Free Tier.

---

## 1. Persiapan: Ambil Cookie Session

1. Buka browser dan login ke `https://agentrouter.org` via akun GitHub Anda.
2. Masuk ke dashboard / console.
3. Buka **Developer Tools** (`F12`) > tab **Network** > ketik filter `self`.
4. Refresh halaman (`Ctrl + R`).
5. Klik baris `self` (URL: `/api/user/self`), lalu di panel kanan bagian **Request Headers**, salin seluruh nilai dari baris **`cookie:`**.

---

## 2. Setup & Deploy ke Cloudflare

### Langkah 1: Clone Repository
```bash
git clone https://github.com/bismawy/agentrouter-daily.git
cd agentrouter-daily
bun install   # atau: npm install
```

### Langkah 2: Login ke Cloudflare
```bash
npx wrangler login
```

### Langkah 3: Simpan Cookie Session ke Secrets
```bash
npx wrangler secret put AGENTROUTER_COOKIE
```
*(Paste nilai cookie yang disalin dari langkah persiapan)*

### Langkah 4: Deploy Worker
```bash
bun run deploy
# atau
npm run deploy
```

Setelah selesai, Cloudflare akan menampilkan tautan publik worker Anda:
`https://agentrouter-autoclaim.<subdomain>.workers.dev`

---

## 3. Cara Penggunaan & Pengecekan

Buka tautan worker Anda di browser:
👉 **`https://agentrouter-autoclaim.<subdomain>.workers.dev/`**

Di halaman tersebut akan tampil:
- **Saldo Terkini**: Total akumulasi credit ($USD).
- **Akun**: Info akun GitHub yang terhubung.
- **Status Hari Ini**: `Terklaim` / `Belum Diklaim`.
- **Riwayat Log**: Tabel tanggal, status klaim (`BERHASIL` / `GAGAL`), saldo, dan keterangan.
- **Tombol `[ Klaim Sekarang ]`**: Untuk cek langsung tanpa menunggu jadwal cron harian.

---

## 4. Konfigurasi Jadwal Cron (Opsional)

Jadwal otomatisasi diatur di file `wrangler.toml`:
```toml
[triggers]
crons = ["0 1 * * *"] # Setiap hari pukul 01:00 UTC (08:00 WIB)
```

Untuk mengubah waktu eksekusi:
- Pukul 00:00 WIB: `"0 17 * * *"`
- Pukul 07:00 WIB: `"0 0 * * *"`
- Pukul 12:00 WIB: `"0 5 * * *"`

Setelah mengubah `wrangler.toml`, deploy ulang dengan `bun run deploy`.
