# Codex Multi Auth Desktop

Ứng dụng Electron tối giản, độc lập để quản lý nhiều session đăng nhập của Codex trên máy cục bộ. App tự xử lý OAuth, quota usage và đồng bộ auth state với Codex CLI; không cần cài hoặc chạy `codex-multi-auth`.

- Đăng nhập account mới bằng browser OAuth (không nhập password vào app).
- Xem danh sách account và quota primary/secondary của từng account.
- Switch thủ công một account, sau đó tự động đóng/mở Codex để nạp auth state mới trên macOS và Windows.
- Export/import toàn bộ session giữa các thiết bị bằng file JSON.

## Chạy local

```bash
npm install
npm start
```

## Đóng gói

```bash
npm run package:mac
npm run package:win
npm run package:linux
```

## Lưu ý bảo mật

File export chứa refresh token. Nó tương đương một phiên đăng nhập: chỉ chuyển qua kênh riêng tư, không commit, không gửi vào chat/email công khai và xoá khi hoàn tất import.

Session app được lưu riêng tại `~/.codex/multi-auth-desktop/`. Khi chạy lần đầu, app có thể migrate session cũ từ `~/.codex/multi-auth/` để không mất account.
