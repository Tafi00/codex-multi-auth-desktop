# Codex Multi Auth Desktop

Ứng dụng Electron tối giản, độc lập để quản lý nhiều session đăng nhập của Codex trên máy cục bộ. App tự xử lý OAuth, quota usage và đồng bộ auth state với Codex CLI; không cần cài hoặc chạy `codex-multi-auth`.

- Đăng nhập account mới bằng browser OAuth (không nhập password vào app).
- Xem danh sách account và quota primary/secondary của từng account.
- Switch thủ công một account, sau đó tự động đóng/mở Codex để nạp auth state mới trên macOS và Windows.
- Export/import toàn bộ session giữa các thiết bị bằng file JSON thuần, không cần password.

## Xác minh số điện thoại (HeroSMS)

Khi OpenAI yêu cầu số điện thoại, app có thể tự thuê số qua [HeroSMS](https://hero-sms.com/) (API tương thích SMS-Activate). Mở **Phone verification** trên thanh header để nhập API key, kiểm tra balance và chọn quốc gia cùng mức giá hiện tại.

Các thông số vận hành được cố định trong app:

| Thông số | Giá trị | Ghi chú |
| --- | --- | --- |
| Service | `dr` | OpenAI |
| Số lần đổi số tối đa | `10` | Dừng tự động sau số thứ 10 |
| Thời gian chờ OTP | `10s` | Hết thời gian thì đổi số khác |
| API | `https://hero-sms.com/stubs/handler_api.php` | HeroSMS |

Luồng chạy: thuê số → điền vào form → nếu OpenAI báo lỗi (số đã dùng) thì thuê số mới ngay và đợi đủ 2 phút mới huỷ số cũ để được hoàn tiền → lặp lại đến khi số được chấp nhận → poll API lấy OTP và điền vào trang xác minh.

API key được mã hóa bằng kho bảo mật hệ điều hành, lưu tại `~/.codex/multi-auth-desktop/settings.json` và không bao giờ được gửi ra tiến trình renderer. Nếu app bị tắt trước khi hết 2 phút, số bị từ chối sẽ không được huỷ tự động — cần huỷ tay trên dashboard HeroSMS để lấy lại tiền.

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

File export không được mã hóa và chứa refresh token cùng thông tin đăng nhập đã lưu. Nó tương đương một phiên đăng nhập: chỉ chuyển qua kênh riêng tư, không commit, không gửi vào chat/email công khai và xoá khi hoàn tất import.

Session app được lưu riêng tại `~/.codex/multi-auth-desktop/`. Khi chạy lần đầu, app có thể migrate session cũ từ `~/.codex/multi-auth/` để không mất account.
