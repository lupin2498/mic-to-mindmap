"""Bản ghi mẫu (tự viết, mô phỏng cuộc họp/bài giảng thật) dùng để kiểm chất lượng bộ máy tóm tắt không cần AI
và để so bản Python với bản JavaScript."""
SAMPLES = {}

SAMPLES["vi_clean"] = dict(title="Họp kế hoạch", participants=["An", "Bình", "Chi"], language="vi", text=(
    "Hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới. Kế hoạch ra mắt dự kiến vào tháng 12. "
    "Khách hàng đã phản hồi tốt về bản thử nghiệm. Bộ phận marketing cần chuẩn bị chiến dịch quảng cáo cho sản phẩm mới. "
    "An sẽ phụ trách liên hệ khách hàng lớn trước thứ sáu. Chúng ta thống nhất chốt ngân sách 500 triệu cho chiến dịch. "
    "Bình phải gửi báo cáo tiến độ vào ngày 15/11. Chi đề xuất tổ chức buổi demo cho khách hàng vào tuần sau. "
    "Mọi người đồng ý tổ chức demo tại văn phòng."))

# Kiểu văn bản từ nhận dạng giọng nói: chữ thường, không dấu câu, mỗi lần ngắt hơi thành một "câu", có từ đệm
SAMPLES["vi_speech"] = dict(title="", participants=[], language="vi", text=(
    "alo mọi người nghe rõ không. ok vậy mình bắt đầu nhé. hôm nay chúng ta họp về tình hình doanh thu quý ba và kế hoạch quý bốn. "
    "à thì doanh thu quý ba đạt 12 tỷ tăng 15% so với quý hai. trong đó kênh online chiếm khoảng 60% doanh thu. "
    "ừm kênh cửa hàng thì giảm nhẹ do đang sửa chữa hai cửa hàng ở quận 1. "
    "về chi phí thì chi phí quảng cáo tăng khá nhiều khoảng 30% so với kế hoạch. "
    "anh hùng nghĩ là mình cần xem lại hiệu quả quảng cáo trên facebook. "
    "chị lan đề xuất chuyển một phần ngân sách quảng cáo sang tiktok vì khách hàng trẻ ở đó nhiều hơn. "
    "mọi người thấy sao. em đồng ý với chị lan. ok vậy chúng ta thống nhất chuyển 20% ngân sách quảng cáo sang tiktok từ tháng 11. "
    "về kế hoạch quý bốn thì mục tiêu doanh thu là 15 tỷ. để đạt mục tiêu doanh thu thì cần mở thêm một cửa hàng ở thủ đức. "
    "anh hùng sẽ phụ trách tìm mặt bằng trước ngày 20 tháng 10. chị lan sẽ lên kế hoạch quảng cáo tiktok và gửi cho mọi người vào thứ sáu tuần này. "
    "còn em minh thì cần tổng hợp phản hồi khách hàng về sản phẩm mới trước cuối tháng. "
    "à còn một vấn đề nữa là tồn kho đang khá cao. tồn kho hiện tại khoảng 3 tỷ chủ yếu là hàng mùa hè. "
    "chúng ta quyết định chạy chương trình khuyến mãi xả tồn kho trong tháng 10. "
    "phòng kế toán cần gửi báo cáo tồn kho chi tiết trước thứ tư. "
    "rồi vậy thôi cảm ơn mọi người nhé. hẹn gặp lại tuần sau."))

SAMPLES["vi_lecture"] = dict(title="", participants=[], language="auto", text=(
    "Chào các bạn, hôm nay chúng ta học về quang hợp ở thực vật. Quang hợp là quá trình cây xanh sử dụng năng lượng ánh sáng "
    "để tổng hợp chất hữu cơ từ nước và khí cacbonic. Quá trình quang hợp diễn ra chủ yếu ở lá cây, trong các bào quan gọi là lục lạp. "
    "Lục lạp chứa chất diệp lục, chất này hấp thụ ánh sáng mặt trời. Quang hợp gồm hai pha là pha sáng và pha tối. "
    "Pha sáng diễn ra ở màng tilacoit, cần có ánh sáng, tạo ra ATP và NADPH đồng thời giải phóng khí oxy. "
    "Pha tối diễn ra ở chất nền của lục lạp, không cần ánh sáng trực tiếp, sử dụng ATP và NADPH để cố định khí cacbonic thành đường glucozơ. "
    "Các yếu tố ảnh hưởng đến quang hợp gồm cường độ ánh sáng, nồng độ khí cacbonic, nhiệt độ và nước. "
    "Khi cường độ ánh sáng tăng thì tốc độ quang hợp tăng đến một điểm bão hòa. "
    "Nhiệt độ thích hợp cho quang hợp ở đa số thực vật là từ 25 đến 35 độ C. "
    "Quang hợp có vai trò rất quan trọng vì nó tạo ra khí oxy cho sự sống và là nguồn chất hữu cơ cho mọi sinh vật. "
    "Các bạn lưu ý phân biệt pha sáng và pha tối vì phần này hay ra trong đề thi. "
    "Về nhà các bạn cần làm bài tập trang 45 và nộp vào thứ hai tuần sau. Tuần sau chúng ta sẽ học về hô hấp ở thực vật."))

SAMPLES["en"] = dict(title="Launch sync", participants=["Alice", "Bob"], language="en", text=(
    "Okay, let's get started. Today we reviewed the launch plan for the new product. The launch plan is scheduled for December. "
    "The beta feedback from customers has been mostly positive. However, the onboarding flow still confuses new users. "
    "Alice will redesign the onboarding flow by Friday. We agreed to approve the marketing budget of 50,000 dollars. "
    "The marketing team should prepare the campaign next week. Bob needs to follow up with the payment vendor about the API limits. "
    "We decided to postpone the mobile app until Q1. Pricing is still an open question. Should we offer a free tier? "
    "Bob will send the pricing analysis before the next meeting. Thanks everyone, see you next week."))

SAMPLES["vi_short"] = dict(title="", participants=[], language="vi", text=(
    "mai nhớ mua sữa cho con. gọi điện cho mẹ hỏi thăm sức khỏe. chuẩn bị tài liệu cho buổi thuyết trình thứ năm."))

SAMPLES["vi_long_speech"] = dict(title="", participants=["Tuấn", "Hà", "Phương"], language="vi", text=(
    "rồi chúng ta bắt đầu buổi họp dự án ứng dụng đặt lịch khám bệnh nhé. "
    "đầu tiên là phần tiến độ. hiện tại phần giao diện người dùng đã xong khoảng 80%. còn phần đặt lịch và thanh toán thì đang làm. "
    "tuấn báo cáo là phần đăng nhập bằng số điện thoại đã hoàn thành và đã kiểm thử xong. "
    "phần đặt lịch thì đang bị chậm khoảng một tuần do bên bệnh viện chưa gửi tài liệu kỹ thuật về hệ thống của họ. "
    "hà sẽ liên hệ lại với bệnh viện để xin tài liệu kỹ thuật trong hôm nay. "
    "thứ hai là vấn đề thanh toán. chúng ta đang cân nhắc giữa hai phương án là tích hợp ví điện tử hoặc là chuyển khoản ngân hàng. "
    "ví điện tử thì tiện cho người dùng nhưng phí giao dịch cao khoảng 2%. chuyển khoản ngân hàng thì phí thấp hơn nhưng trải nghiệm người dùng không tốt bằng. "
    "phương thấy là nên làm ví điện tử trước vì đa số người dùng trẻ đều quen dùng ví điện tử rồi. "
    "sau khi thảo luận thì mọi người thống nhất làm ví điện tử trước còn chuyển khoản ngân hàng để phiên bản sau. "
    "tiếp theo là vấn đề kiểm thử. hiện tại chưa có ai phụ trách kiểm thử tự động. tuấn đề xuất thuê thêm một bạn kiểm thử làm bán thời gian. "
    "chi phí thuê khoảng 8 triệu một tháng. cái này cần anh giám đốc phê duyệt. phương sẽ gửi đề xuất cho anh giám đốc trước thứ tư. "
    "ngoài ra còn rủi ro về bảo mật dữ liệu bệnh nhân. dữ liệu bệnh nhân là dữ liệu nhạy cảm nên phải mã hóa toàn bộ. "
    "tuấn cần rà soát lại phần lưu trữ dữ liệu bệnh nhân và báo cáo vào tuần sau. "
    "về lịch ra mắt thì dự kiến ra mắt bản thử nghiệm vào ngày 15 tháng 12. bản chính thức thì sau tết. "
    "để kịp lịch ra mắt thì phần đặt lịch phải xong trước ngày 30 tháng 11. "
    "cuối cùng là phần truyền thông. hà đề xuất làm video ngắn giới thiệu ứng dụng đăng lên mạng xã hội. mọi người đồng ý làm video ngắn nhưng ngân sách không quá 20 triệu. "
    "tóm lại tuần này ưu tiên số một là lấy được tài liệu kỹ thuật từ bệnh viện. ok cảm ơn mọi người."))
