# Codex Multi Auth Desktop

Ứng dụng Electron tối giản, độc lập để quản lý nhiều session đăng nhập của Codex trên máy cục bộ. App tự xử lý OAuth, quota usage và đồng bộ auth state với Codex CLI; không cần cài hoặc chạy `codex-multi-auth`.

- Đăng nhập account mới bằng browser OAuth: chọn Google, passkey hoặc phương thức OpenAI mong muốn. Trên macOS, app mở Chrome Guest tiếng Anh và điều khiển bằng Playwright để tự điền/chuyển bước, đồng thời Touch ID/iCloud Keychain vẫn có thể hiển thị popup passkey.
- Xem danh sách account và quota primary/secondary của từng account.
- Switch thủ công một account, sau đó tự động đóng/mở Codex để nạp auth state mới trên macOS và Windows.
- Đăng nhập GitHub và đồng bộ account/session qua private repository để merge giữa các thiết bị.
- Export/import toàn bộ session giữa các thiết bị bằng file JSON thuần, không cần password. File export được đọc lại để xác nhận đã ghi đầy đủ; khi import, account trùng được cập nhật bằng dữ liệu mới trong file.

## GitHub account sync

Không cần cài GitHub CLI. Nhấn **Sign in with GitHub**; app mở GitHub trong browser bằng OAuth Device Flow, copy login code tự động và hoàn tất kết nối khi bạn xác nhận trên GitHub. OAuth App đã bật Device Flow, vì thế desktop app chỉ dùng client ID công khai — không đóng gói client secret.

Access token và refresh token GitHub được mã hóa trong secure storage của hệ điều hành và không được đưa vào renderer hay GitHub vault. Quyền `repo` được dùng duy nhất để tạo/cập nhật repository sync private; GitHub sẽ hiển thị quyền này trước khi bạn cấp lần đầu.

Lần kết nối đầu tiên sẽ tạo repository private `codex-multi-auth-sync` trong GitHub account đang hoạt động và ghi file `vault.json`.

- `vault.json` chứa OAuth session để account mới có thể được merge sang thiết bị khác. Khi account đã tồn tại trên máy, token local được ưu tiên để hạn chế refresh token giữa các thiết bị ghi đè lẫn nhau.
- Login details đã lưu (nếu có) vẫn ở dạng thường trong private repository. Không cấp quyền repository cho người khác, không đổi repository thành public, và bảo vệ GitHub bằng passkey/2FA.
- Login/import/delete tự sync sau khi GitHub sync được kết nối. App cũng pull/merge khi khởi động; nút **Sync now** dùng để đồng bộ thủ công.
- Conflict được xử lý theo thay đổi mới nhất. Thao tác xóa có tombstone nên account không bị một máy cũ thêm trở lại.
- Disconnect chỉ xóa liên kết trên máy hiện tại; private repository và vault vẫn còn trên GitHub.
- Không đổi repository thành public. App sẽ từ chối sync nếu phát hiện repository cùng tên đang public.

## Xác minh số điện thoại (HeroSMS)

Khi OpenAI yêu cầu số điện thoại, app có thể tự thuê số qua [HeroSMS](https://hero-sms.com/) (API tương thích SMS-Activate). Mở **Phone verification** trên thanh header để nhập API key, kiểm tra balance và chọn quốc gia cùng mức giá hiện tại.

Các thông số vận hành được cố định trong app:

| Thông số | Giá trị | Ghi chú |
| --- | --- | --- |
| Service | `dr` | OpenAI |
| Số lần đổi số tối đa | `3` | Dừng tự động sau số thứ 3 |
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

## Tự động cập nhật qua GitHub

App đã đóng gói sẽ tự kiểm tra GitHub Releases khi khởi động và mỗi 30 phút. Có thể kiểm tra ngay bằng nút **Check update** trên thanh công cụ. Khi tải xong bản mới, app hỏi người dùng khởi động lại để cài; nếu chọn **Để sau**, bản cập nhật sẽ được cài khi thoát app.

Để phát hành, tăng `version` trong `package.json`, tạo và push tag cùng phiên bản (ví dụ `v0.1.26`). Workflow sẽ build Windows/macOS, publish kèm các file metadata `latest*.yml`, chỉ giữ **5 GitHub Releases mới nhất**, và xoá Actions artifacts cũ để tránh dùng hết quota. Tag Git cũ vẫn được giữ lại.

Auto-update trên macOS yêu cầu bundle có chữ ký hợp lệ. Khi chưa có certificate secrets, workflow dùng chữ ký ad-hoc để Squirrel.Mac có thể xác minh update. Khi phát hành rộng rãi, nên thêm `CSC_LINK` (Developer ID Application certificate `.p12` dạng base64 hoặc URL) và `CSC_KEY_PASSWORD` để ký chính thức và tránh cảnh báo Gatekeeper ở lần cài đầu.

GitHub Releases dùng làm nguồn cập nhật phải truy cập công khai. Repository hiện tại đang private, vì vậy trước khi phát hành cần đổi repository này sang public hoặc trỏ `build.publish` và workflow sang một public repository chỉ chứa release binaries. Không nhúng GitHub PAT vào app để đọc release private.

## Lưu ý bảo mật

File export không được mã hóa và chứa refresh token cùng thông tin đăng nhập đã lưu. Nó tương đương một phiên đăng nhập: chỉ chuyển qua kênh riêng tư, không commit, không gửi vào chat/email công khai và xoá khi hoàn tất import.

Session app được lưu riêng tại `~/.codex/multi-auth-desktop/`. Khi chạy lần đầu, app có thể migrate session cũ từ `~/.codex/multi-auth/` để không mất account.
