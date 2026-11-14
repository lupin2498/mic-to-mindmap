/* Dữ liệu ngôn ngữ dùng chung cho bộ máy tóm tắt không cần AI (tiếng Việt + tiếng Anh).
   Phần nằm giữa hai dấu mốc M2M-DATA là JSON thuần (nháy kép, không dấu phẩy thừa, không chú thích):
   - trình duyệt và node nạp file này như một script bình thường (engine.js dùng M2M_ENGINE_DATA);
   - máy chủ Python (app/engine_data.py) cắt lấy đúng phần JSON đó để hai bên luôn dùng chung một bộ dữ liệu.
   Thêm từ: sửa trực tiếp các mảng bên dưới, viết chữ thường. Chạy `python3 -m pytest tests/test_engine_parity.py` để kiểm. */
(function (root) {
  'use strict';
  var DATA = /*M2M-DATA-BEGIN*/{
    "version": 1,
    "vi_stopwords": [
      "và", "là", "của", "có", "được", "cho", "trong", "này", "đó", "với", "các", "những", "một", "để", "thì", "mà",
      "cũng", "như", "khi", "đã", "sẽ", "đang", "về", "ra", "vào", "lên", "xuống", "tôi", "bạn", "anh", "chị", "em",
      "ta", "mình", "họ", "nó", "ở", "từ", "đến", "tới", "nhưng", "hay", "hoặc", "nếu", "vì", "nên", "bị", "rất",
      "lại", "còn", "chỉ", "đều", "cái", "gì", "không", "chưa", "chẳng", "ạ", "à", "á", "ừ", "ờ", "ơ", "nhé", "nha",
      "nhá", "nhỉ", "thôi", "đấy", "đây", "kia", "ấy", "rồi", "vậy", "thế", "nào", "sao", "bao", "nhiêu", "mấy",
      "theo", "trên", "dưới", "sau", "trước", "giữa", "ngoài", "bên", "cả", "mỗi", "từng", "nữa", "luôn", "hơn",
      "nhất", "quá", "lắm", "thật", "vẫn", "đi", "làm", "nói", "biết", "thấy", "ok", "okay", "oke", "dạ", "vâng",
      "ừm", "um", "uh", "ờm", "ùm", "kiểu", "tức", "chứ", "bởi", "tại", "nọ", "hả", "hử", "ha", "hà", "ơi", "tao",
      "tớ", "chúng", "ai", "đâu", "phải", "cần", "muốn", "hãy", "đừng", "xin", "thưa", "kính", "ông", "bà", "cô",
      "chú", "bác", "cậu", "mợ", "việc", "điều", "thứ", "lúc", "khoảng", "chút", "ít", "nhiều", "hết", "xong", "mọi",
      "người", "hôm", "nay", "giờ", "bây", "so", "do", "bằng", "qua", "cùng", "rằng", "dù", "tuy", "mặc", "vừa",
      "sắp", "thường", "cứ", "càng", "khá", "hơi", "cực", "siêu", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám",
      "chín", "mười", "trăm", "nghìn", "ngàn", "triệu", "tỷ", "tỉ", "vài", "dăm", "mươi", "rưỡi", "ngày", "tháng",
      "tuần", "quý", "phút", "giây", "mai", "con", "chiếc", "cuộc", "buổi", "bọn", "nhằm", "nhen", "hen", "nghen",
      "kìa", "liền", "bèn", "toàn", "tự", "lẫn", "nhau", "riêng", "chung", "thêm", "bớt"
    ],
    "en_stopwords": [
      "a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "to", "in", "on", "at", "for", "with", "by",
      "from", "as", "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "have",
      "has", "had", "having", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my",
      "your", "his", "its", "our", "their", "this", "that", "these", "those", "there", "here", "what", "which",
      "who", "whom", "whose", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most",
      "other", "some", "such", "no", "nor", "not", "only", "own", "same", "than", "too", "very", "can", "will",
      "just", "should", "would", "could", "may", "might", "must", "shall", "also", "about", "into", "over", "after",
      "before", "again", "further", "once", "up", "down", "out", "off", "under", "yeah", "yes", "okay", "ok", "um",
      "uh", "like", "well", "right", "actually", "basically", "literally", "kind", "sort", "gonna", "wanna", "going",
      "get", "gets", "got", "let", "lets", "make", "makes", "made", "say", "says", "said", "think", "know", "see",
      "want", "wants", "need", "needs", "thing", "things", "lot", "bit", "one", "two", "three", "four", "five",
      "six", "seven", "eight", "nine", "ten", "first", "second", "third", "still", "even", "much", "many", "really",
      "maybe", "probably", "today", "tomorrow", "yesterday", "week", "weeks", "month", "months", "year", "years",
      "day", "days", "time", "next", "last", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
      "sunday", "now", "please", "thanks", "thank", "hello", "hi", "hey", "bye", "don't", "doesn't", "didn't",
      "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't", "couldn't", "shouldn't", "can't", "cannot", "i'm",
      "i've", "i'll", "i'd", "we're", "we've", "we'll", "we'd", "you're", "you've", "you'll", "they're", "they've",
      "they'll", "it's", "that's", "there's", "here's", "what's", "let's", "he's", "she's", "etc", "via", "per",
      "around", "between", "through", "during", "while", "because", "however", "although", "though", "either",
      "neither", "every", "everyone", "everybody", "someone", "something", "anything", "nothing", "anyone", "mr",
      "ms", "mrs", "dr"
    ],
    "vi_stop_phrases": [
      "chúng ta", "chúng tôi", "chúng mình", "chúng em", "bọn mình", "bọn em", "mọi người", "các bạn", "các anh",
      "các chị", "anh chị", "anh em", "cả nhà", "hôm nay", "hôm qua", "hôm trước", "hôm sau", "ngày mai", "ngày kia",
      "bây giờ", "hiện tại", "hiện nay", "lúc này", "lúc đó", "sau đó", "trước đó", "sau này", "trước đây",
      "vừa rồi", "vừa qua", "sắp tới", "tới đây", "như vậy", "như thế", "thế này", "vậy thì", "thế thì", "tức là",
      "nghĩa là", "có nghĩa", "nói chung", "nhìn chung", "thật ra", "thực ra", "đại khái", "đại loại", "túm lại",
      "tóm lại", "nói tóm lại", "có thể", "không thể", "có lẽ", "chắc là", "chắc chắn", "cần phải", "nên là",
      "cho nên", "bởi vì", "tại vì", "vì vậy", "vì thế", "do đó", "do vậy", "tuy nhiên", "mặc dù", "nhưng mà",
      "ngoài ra", "bên cạnh", "bên cạnh đó", "đồng thời", "ví dụ", "ví dụ như", "chẳng hạn", "một số", "một vài",
      "một chút", "một ít", "rất nhiều", "khá nhiều", "tất cả", "bất kỳ", "bất cứ", "cái này", "cái đó", "cái kia",
      "điều này", "điều đó", "việc này", "việc đó", "ở đây", "ở đó", "như là", "kiểu như", "gọi là", "coi như",
      "xem như", "thì là", "mà là", "đó là", "đây là", "là vì", "để mà", "ra sao", "thế nào", "như nào", "làm sao",
      "tại sao", "vì sao", "bao nhiêu", "bao giờ", "khi nào", "ở đâu", "đâu đó", "cảm ơn", "cám ơn", "xin chào",
      "xin lỗi", "được rồi", "đúng rồi", "thế là", "rồi thì", "tiếp theo", "thứ nhất", "đầu tiên", "cuối cùng",
      "sau cùng", "trước hết", "trước tiên", "còn lại", "với lại", "hơn nữa", "thêm nữa", "nói về", "về phần",
      "liên quan", "đối với", "dựa trên", "dựa vào", "theo như", "so với", "cùng với", "kể cả", "trong đó",
      "trong khi", "trong lúc", "khi mà", "sau khi", "trước khi", "cho đến", "cho tới", "kể từ", "từ khi", "nếu như",
      "giả sử", "miễn là", "để cho", "tuần này", "tuần sau", "tuần tới", "tuần trước", "tháng này", "tháng sau",
      "tháng tới", "tháng trước", "năm nay", "năm sau", "năm tới", "năm ngoái", "năm trước", "cuối tuần", "đầu tuần",
      "cuối tháng", "đầu tháng", "cuối năm", "đầu năm", "cuối quý", "đầu quý", "buổi sáng", "buổi chiều", "buổi tối",
      "một cách", "à thì", "ờ thì", "thế nhưng", "vậy nên", "chứ không", "hay là", "hoặc là", "không phải",
      "có phải", "phải không", "đúng không", "được không", "dưới đây", "trên đây", "sau đây", "như sau", "vân vân",
      "vân vân và vân vân", "phần trăm", "lần này", "lần sau", "lần trước", "lần tới", "ngay lập tức",
      "ngay bây giờ", "càng sớm càng tốt", "thay vì", "mặt khác", "nói cách khác", "nói riêng", "nói thật",
      "nói thẳng", "theo tôi", "theo em", "theo anh", "theo chị", "theo mình", "tôi nghĩ", "em nghĩ", "anh nghĩ",
      "chị nghĩ", "mình nghĩ", "tôi thấy", "em thấy", "anh thấy", "chị thấy", "mình thấy", "sáng mai", "chiều mai",
      "tối mai", "trưa mai", "sáng nay", "chiều nay", "tối nay", "trưa nay", "đêm nay", "đêm qua", "tối qua",
      "sáng qua", "chiều qua", "vậy mà"
    ],
    "vi_lexicon": [
      "kế hoạch", "ra mắt", "sản phẩm", "khách hàng", "ngân sách", "chiến dịch", "quảng cáo", "báo cáo", "tiến độ",
      "doanh thu", "lợi nhuận", "chi phí", "giá thành", "giá bán", "giá cả", "thị trường", "thị phần", "đối thủ",
      "cạnh tranh", "đối tác", "hợp đồng", "hợp tác", "dự án", "dự kiến", "dự báo", "dự toán", "dự thảo", "mục tiêu",
      "chỉ tiêu", "kết quả", "hiệu quả", "chất lượng", "số lượng", "sản lượng", "năng suất", "quy trình", "quy định",
      "quy mô", "quy chế", "chính sách", "chiến lược", "giải pháp", "phương án", "phương pháp", "phương hướng",
      "đề xuất", "đề nghị", "yêu cầu", "nhu cầu", "ý kiến", "ý tưởng", "phản hồi", "góp ý", "đánh giá", "nhận xét",
      "thảo luận", "trao đổi", "thống nhất", "quyết định", "phê duyệt", "kết luận", "cuộc họp", "buổi họp",
      "biên bản", "nội dung", "chương trình", "lịch trình", "lịch họp", "thời gian", "thời hạn", "hạn chót",
      "tiến trình", "giai đoạn", "hoàn thành", "hoàn thiện", "triển khai", "thực hiện", "thực thi", "tổ chức",
      "chuẩn bị", "liên hệ", "liên lạc", "phụ trách", "đảm nhận", "phối hợp", "hỗ trợ", "theo dõi", "kiểm tra",
      "kiểm soát", "giám sát", "quản lý", "quản trị", "điều hành", "điều phối", "lãnh đạo", "giám đốc",
      "tổng giám đốc", "phó giám đốc", "trưởng phòng", "phó phòng", "trưởng nhóm", "trưởng ban", "nhân viên",
      "nhân sự", "nhân lực", "nguồn lực", "tuyển dụng", "đào tạo", "lương thưởng", "tiền lương", "phúc lợi",
      "bộ phận", "phòng ban", "công ty", "doanh nghiệp", "tập đoàn", "chi nhánh", "văn phòng", "trụ sở", "cửa hàng",
      "đại lý", "nhà cung cấp", "nhà phân phối", "nhà đầu tư", "cổ đông", "cổ phần", "đầu tư", "tài chính",
      "kế toán", "kiểm toán", "ngân hàng", "tín dụng", "vay vốn", "vốn đầu tư", "dòng tiền", "công nợ", "hóa đơn",
      "thanh toán", "tạm ứng", "quyết toán", "pháp lý", "pháp luật", "giấy phép", "thủ tục", "hồ sơ", "tài liệu",
      "văn bản", "công văn", "thông báo", "thông tin", "dữ liệu", "số liệu", "thống kê", "phân tích", "nghiên cứu",
      "khảo sát", "thử nghiệm", "thí điểm", "kiểm thử", "kiểm định", "phát triển", "tăng trưởng", "mở rộng",
      "cải thiện", "cải tiến", "nâng cấp", "tối ưu", "đổi mới", "sáng tạo", "rủi ro", "vấn đề", "khó khăn",
      "thách thức", "cơ hội", "lợi thế", "ưu điểm", "nhược điểm", "điểm mạnh", "điểm yếu", "nguyên nhân", "lý do",
      "trách nhiệm", "nhiệm vụ", "công việc", "phân công", "bàn giao", "nghiệm thu", "bảo hành", "bảo trì",
      "bảo dưỡng", "vận hành", "sản xuất", "nhà máy", "nhà xưởng", "dây chuyền", "nguyên liệu", "vật liệu", "vật tư",
      "thiết bị", "máy móc", "kho hàng", "tồn kho", "nhập hàng", "xuất hàng", "giao hàng", "vận chuyển", "đơn hàng",
      "đặt hàng", "bán hàng", "mua hàng", "kinh doanh", "tiếp thị", "thương hiệu", "truyền thông", "sự kiện",
      "hội thảo", "hội nghị", "triển lãm", "khuyến mãi", "giảm giá", "ưu đãi", "chăm sóc", "dịch vụ", "trải nghiệm",
      "người dùng", "người tiêu dùng", "người mua", "người bán", "phân khúc", "bán lẻ", "bán buôn", "trực tuyến",
      "trực tiếp", "gián tiếp", "mạng xã hội", "trang web", "ứng dụng", "phần mềm", "phần cứng", "hệ thống",
      "nền tảng", "công nghệ", "kỹ thuật", "tính năng", "chức năng", "giao diện", "thiết kế", "lập trình",
      "mã nguồn", "cơ sở dữ liệu", "máy chủ", "máy tính", "điện thoại", "bảo mật", "an toàn", "an ninh", "hiệu năng",
      "tốc độ", "phiên bản", "cập nhật", "sửa lỗi", "tự động", "thủ công", "tích hợp", "kết nối", "đồng bộ",
      "sao lưu", "khôi phục", "cài đặt", "cấu hình", "tài khoản", "mật khẩu", "đăng nhập", "đăng ký",
      "trí tuệ nhân tạo", "học máy", "mô hình", "thuật toán", "bài học", "bài giảng", "bài tập", "bài toán",
      "bài viết", "giáo viên", "học sinh", "sinh viên", "giảng viên", "nhà trường", "lớp học", "môn học", "khóa học",
      "kiến thức", "kỹ năng", "kinh nghiệm", "khái niệm", "định nghĩa", "lý thuyết", "thực hành", "thực tế",
      "nguyên tắc", "nguyên lý", "quy luật", "công thức", "phương trình", "câu hỏi", "câu trả lời", "đáp án",
      "kỳ thi", "điểm số", "học tập", "luận văn", "đề tài", "tham khảo", "trình bày", "thuyết trình", "gia đình",
      "xã hội", "kinh tế", "chính trị", "văn hóa", "giáo dục", "y tế", "sức khỏe", "môi trường", "năng lượng",
      "giao thông", "xây dựng", "bất động sản", "du lịch", "nông nghiệp", "công nghiệp", "thương mại", "xuất khẩu",
      "nhập khẩu", "quốc tế", "trong nước", "nước ngoài", "địa phương", "thành phố", "khu vực", "đất nước",
      "chính phủ", "nhà nước", "cơ quan", "đơn vị", "cá nhân", "tập thể", "cộng đồng", "thế giới", "tương lai",
      "quá khứ", "lịch sử", "sử dụng", "áp dụng", "lựa chọn", "xác định", "xác nhận", "đảm bảo", "bảo đảm",
      "cam kết", "tham gia", "tham dự", "có mặt", "vắng mặt", "bắt đầu", "kết thúc", "tiếp tục", "tạm dừng",
      "thay đổi", "điều chỉnh", "bổ sung", "loại bỏ", "giảm bớt", "tăng cường", "tập trung", "ưu tiên", "quan tâm",
      "lưu ý", "chú ý", "ghi nhận", "ghi chú", "nhắc lại", "nhấn mạnh", "giới thiệu", "chia sẻ", "giải quyết",
      "xử lý", "khắc phục", "đáp ứng", "phục vụ", "cung cấp", "phân phối", "quan trọng", "cần thiết", "khẩn cấp",
      "cụ thể", "chi tiết", "tổng quan", "tổng hợp", "tổng kết", "đầy đủ", "chính xác", "rõ ràng", "hợp lý",
      "phù hợp", "khả thi", "ổn định", "linh hoạt", "đơn giản", "phức tạp", "nhanh chóng", "kịp thời", "đưa ra",
      "đề ra", "tìm ra", "nhận ra", "tạo ra", "xảy ra", "diễn ra", "đặt ra", "chỉ ra", "làm việc", "việc làm",
      "làm rõ", "làm mới", "làm chủ", "sở hữu", "nói chuyện", "cho phép", "cho biết", "cho thấy", "con người",
      "điều kiện", "điều khoản", "thứ tự", "lần lượt", "thời điểm", "thời kỳ", "đi lại", "đi làm", "lên kế hoạch",
      "lên lịch", "xuống cấp", "nhìn nhận", "tự do", "tự tin", "tự hào", "mối quan hệ", "quan hệ", "kết hợp",
      "liên kết", "hợp lệ", "hợp pháp", "bảo hiểm", "bảo vệ", "an sinh", "lao động", "công nhân", "kỹ sư",
      "chuyên gia", "chuyên viên", "tư vấn", "cố vấn", "thư ký", "trợ lý", "đồng nghiệp", "đội ngũ", "thành viên",
      "cộng tác viên", "ứng viên", "phỏng vấn", "hợp đồng lao động", "thử việc", "nghỉ phép", "làm thêm", "tăng ca",
      "ca làm", "lịch làm việc", "nội quy", "kỷ luật", "khen thưởng", "thưởng tết", "đánh giá năng lực", "lộ trình",
      "định hướng", "tầm nhìn", "sứ mệnh", "giá trị", "văn hóa công ty", "báo giá", "đấu thầu", "gói thầu",
      "nhà thầu", "thầu phụ", "công trình", "hạng mục", "bản vẽ", "khối lượng", "đơn giá", "định mức",
      "vật tư kỹ thuật", "sửa chữa", "lắp đặt", "thi công", "tiêu chuẩn", "chứng nhận", "chứng chỉ",
      "kiểm tra chất lượng", "an toàn lao động", "phòng cháy", "tiêu thụ", "cung ứng", "chuỗi cung ứng", "hậu cần",
      "kho bãi", "hải quan", "thông quan", "vận tải", "cước phí", "bao bì", "đóng gói", "mẫu mã", "nhãn hiệu",
      "bản quyền", "sáng chế", "độc quyền", "khách sạn", "nhà hàng", "thực đơn", "đặt phòng", "đặt chỗ",
      "vé máy bay", "bệnh viện", "bác sĩ", "bệnh nhân", "thuốc men", "điều trị", "khám bệnh", "xét nghiệm",
      "tiêm chủng", "dinh dưỡng", "tập luyện", "ngân hàng số", "ví điện tử", "chuyển khoản", "tiền mặt", "lãi suất",
      "tỷ giá", "lạm phát", "chứng khoán", "cổ phiếu", "trái phiếu", "quỹ đầu tư", "lợi tức", "thu nhập", "chi tiêu",
      "tiết kiệm", "khoản vay", "thế chấp", "nợ xấu", "thuế thu nhập", "hoàn thuế", "nội dung số", "video ngắn",
      "hình ảnh", "bài đăng", "lượt xem", "lượt thích", "tương tác", "người theo dõi", "người xem", "kênh bán hàng",
      "sàn thương mại", "thương mại điện tử", "chốt đơn", "tỷ lệ chuyển đổi", "chuyển đổi số", "trí tuệ",
      "dữ liệu lớn", "điện toán đám mây", "đám mây", "mã hóa", "xác thực", "phân quyền", "giao thức", "băng thông",
      "độ trễ", "tải trọng", "khả năng mở rộng", "kiến trúc", "vi dịch vụ", "giao diện lập trình",
      "kiểm thử tự động", "triển khai liên tục", "mã nguồn mở", "phản hồi người dùng", "lỗi nghiêm trọng", "bản vá",
      "bản phát hành", "bản thử nghiệm", "bản chính thức", "lộ trình sản phẩm", "yêu cầu kỹ thuật",
      "tài liệu kỹ thuật", "hướng dẫn sử dụng", "hướng dẫn", "đào tạo nội bộ", "quy trình làm việc", "nhóm dự án",
      "ban giám đốc", "hội đồng quản trị", "ban lãnh đạo", "phòng kinh doanh", "phòng kỹ thuật", "phòng nhân sự",
      "phòng kế toán", "phòng marketing", "phòng hành chính", "hành chính", "văn thư", "lưu trữ", "con dấu",
      "chữ ký", "ủy quyền", "biên nhận", "hợp đồng mua bán", "phụ lục", "điều khoản thanh toán", "bảo lãnh",
      "đặt cọc", "tiền cọc", "công suất", "sản xuất thử", "lô hàng", "lỗi sản phẩm", "tỷ lệ lỗi",
      "tiết kiệm chi phí", "cắt giảm", "tối ưu chi phí", "biên lợi nhuận", "điểm hòa vốn", "dự báo doanh thu",
      "kế hoạch kinh doanh", "kế hoạch tài chính", "kế hoạch nhân sự", "kế hoạch marketing", "kế hoạch sản xuất",
      "mục tiêu doanh thu", "khách hàng tiềm năng", "khách hàng thân thiết", "khách hàng mới", "khách hàng cũ",
      "chăm sóc khách hàng", "sự hài lòng", "khiếu nại", "bồi thường", "đổi trả", "chính sách bảo hành",
      "chương trình khuyến mãi", "tri ân", "quà tặng", "thành tích", "kỷ niệm", "lễ ra mắt", "họp báo",
      "thông cáo báo chí", "báo chí", "phóng viên", "tài trợ", "nhà tài trợ", "gây quỹ", "từ thiện", "tình nguyện",
      "câu lạc bộ", "hội nhóm", "thời tiết", "nhiệt độ", "mưa bão", "giao mùa", "kỳ nghỉ", "nghỉ lễ",
      "tết nguyên đán", "sinh nhật", "đám cưới", "tiệc tùng", "ánh sáng", "thực vật", "động vật", "sinh vật",
      "quá trình", "yếu tố", "vai trò", "thế hệ", "thế mạnh", "thế kỷ", "mặt bằng", "cân nhắc", "bán thời gian",
      "toàn thời gian", "số điện thoại", "giao dịch", "giao tiếp", "giao lưu", "phí giao dịch", "mùa hè", "mùa đông",
      "mùa xuân", "mùa thu", "hàng hóa", "mặt hàng", "chủ yếu", "tình hình", "xem lại", "nhạy cảm", "cường độ",
      "nồng độ", "mật độ", "tỷ lệ", "tỉ lệ", "trung bình", "tối đa", "tối thiểu", "tối ưu hóa", "ban đầu",
      "ban ngày", "ban đêm", "buổi học", "tiết học", "học kỳ", "học phí", "nhà cửa", "nhà ở", "căn hộ", "mặt tiền",
      "tiền thuê", "tiền điện", "tiền nước", "hóa chất", "chất liệu", "chất thải", "khí hậu", "khí thải",
      "không khí", "không gian", "thời lượng", "dung lượng", "trọng lượng", "khối lượng công việc", "sức mạnh",
      "sức ép", "áp lực", "động lực", "tinh thần", "cảm xúc", "tâm lý", "thói quen", "hành vi", "xu hướng",
      "bối cảnh", "hoàn cảnh", "tình huống", "trường hợp", "kịch bản", "câu chuyện", "thông điệp", "khẩu hiệu",
      "tiêu đề", "chủ đề", "đề mục", "danh sách", "danh mục", "bảng biểu", "biểu đồ", "sơ đồ", "sơ đồ tư duy",
      "ghi âm", "bản ghi", "tóm tắt", "ý chính", "từ khóa", "giọng nói", "nhận dạng", "chuyển đổi", "đặt lịch",
      "bao gồm", "quý một", "quý hai", "quý ba", "quý bốn"
    ],
    "generic": [
      "tổ chức", "chuẩn bị", "liên hệ", "liên lạc", "phụ trách", "đảm nhận", "thực hiện", "thực thi", "triển khai",
      "hoàn thành", "hoàn thiện", "sử dụng", "áp dụng", "đưa ra", "đề ra", "tìm ra", "nhận ra", "tạo ra", "xảy ra",
      "diễn ra", "đặt ra", "chỉ ra", "làm việc", "làm rõ", "bắt đầu", "kết thúc", "tiếp tục", "thay đổi", "tham gia",
      "tham dự", "xác định", "xác nhận", "đảm bảo", "bảo đảm", "cho phép", "cho biết", "cho thấy", "cần thiết",
      "quan trọng", "cụ thể", "chi tiết", "đầy đủ", "rõ ràng", "phù hợp", "hợp lý", "thời gian", "thời điểm",
      "vấn đề", "nội dung", "công việc", "cuộc họp", "buổi họp", "ý kiến", "thông tin", "trao đổi", "thảo luận",
      "chia sẻ", "giới thiệu", "trình bày", "nhắc lại", "lưu ý", "chú ý", "ghi nhận", "quan tâm", "tập trung",
      "giải quyết", "xử lý", "cung cấp", "hỗ trợ", "phối hợp", "theo dõi", "kiểm tra", "thống nhất", "quyết định",
      "đồng ý", "phê duyệt", "kết luận", "đề xuất", "đề nghị", "yêu cầu", "dự kiến", "có mặt", "vắng mặt",
      "lựa chọn", "điều chỉnh", "bổ sung", "ưu tiên", "nhanh chóng", "kịp thời", "chính xác", "đơn giản", "phức tạp",
      "tổng hợp", "tổng kết", "lần lượt", "gửi", "làm", "họp", "bàn", "mới", "lớn", "nhỏ", "tốt", "xấu", "nhanh",
      "chậm", "cao", "thấp", "dài", "ngắn", "đủ", "thiếu", "tăng", "giảm", "dùng", "mua", "bán", "lấy", "đưa", "đặt",
      "giữ", "bỏ", "xem", "nghe", "đọc", "viết", "hỏi", "chốt", "duyệt", "thích", "nghĩ", "hiểu", "nhớ", "quên",
      "chờ", "đợi", "gặp", "gọi", "báo", "nhắn", "phần", "bản", "mặt", "lần", "loại", "dạng", "mức", "khoản", "mục",
      "điểm", "bước", "cách", "hướng", "chính", "khác", "đúng", "sai", "rõ", "kỹ", "sớm", "muộn", "gấp", "xin",
      "mời", "giúp", "thử", "tính", "định", "chọn", "tìm", "sửa", "đổi", "chuyển", "nhận", "trả", "mở", "đóng",
      "chạy", "đứng", "ngồi", "ăn", "uống", "sáng", "trưa", "chiều", "tối", "đêm", "trẻ", "già", "cũ", "nhẹ", "nặng",
      "mạnh", "yếu", "dễ", "khó", "đẹp", "rẻ", "đắt", "đạt", "gồm", "chiếm", "thing", "things", "stuff", "people",
      "guys", "meeting", "lot", "bit", "way", "kind", "sort", "part", "point", "make", "take", "give", "go", "come",
      "look", "use", "work", "talk", "discuss", "discussed", "put", "start", "end", "new", "good", "great", "bad",
      "big", "small", "sure", "okay", "prepare", "send", "contact", "follow", "update", "check", "share", "finish",
      "complete", "schedule", "deliver", "agreed", "decided", "approve", "approved"
    ],
    "phrase_edge_stop": [
      "gồm", "bao gồm", "đạt", "chiếm", "làm", "gửi", "họp", "bàn", "dùng", "lấy", "đưa", "giữ", "bỏ", "xem", "nghe",
      "đọc", "viết", "hỏi", "chốt", "duyệt", "tăng", "giảm", "phần", "mục", "khoản", "loại", "dạng", "mức", "lần",
      "bước", "cách", "hướng", "thấy", "nghĩ", "muốn", "thích"
    ],
    "topic_intro": [
      "họp về", "học về", "bàn về", "nói về", "thảo luận về", "trao đổi về", "tìm hiểu về", "trình bày về",
      "báo cáo về", "chia sẻ về", "chủ đề là", "chủ đề hôm nay là", "nội dung chính là", "buổi họp", "cuộc họp",
      "today we reviewed", "today we discussed", "today we will discuss", "today we'll discuss",
      "today we will talk about", "today we talk about", "going to talk about", "let's talk about", "the topic is",
      "today's topic is", "meeting about", "going to discuss"
    ],
    "title_skip": [
      "the", "a", "an", "our", "một", "các", "những", "cái", "vấn đề", "tình hình"
    ],
    "conjunctions": [
      "và", "nhưng", "thì", "nên", "rồi", "vì", "nếu", "and", "but", "so", "then", "also", "because", "however"
    ],
    "discourse_markers": [
      "thứ nhất", "thứ hai là", "thứ ba là", "thứ tư là", "tiếp theo", "ngoài ra", "bên cạnh đó", "tuy nhiên",
      "nhưng mà", "sau đó", "cuối cùng", "tóm lại", "vì vậy", "vì thế", "do đó", "cho nên", "còn về", "về phần",
      "về vấn đề", "đối với", "trước hết", "trước tiên", "đầu tiên", "mặt khác", "hơn nữa", "thêm nữa", "một là",
      "hai là", "ba là", "bốn là", "điều thứ hai", "vấn đề thứ hai", "phần tiếp theo", "chuyển sang", "first of all",
      "secondly", "thirdly", "finally", "in addition", "on the other hand", "moving on", "next up", "after that"
    ],
    "lead_fillers": [
      "à", "á", "ờ", "ơ", "ừ", "ừm", "ờm", "ùm", "um", "uh", "er", "dạ", "vâng", "ạ", "ok", "okay", "oke", "rồi",
      "thì", "là", "và", "nhé", "nha", "nào", "vậy", "thế", "à thì", "ờ thì", "thế thì", "vậy thì", "rồi thì",
      "thì là", "nói chung là", "tức là", "kiểu như là", "kiểu như", "đại khái là", "dạ vâng", "vâng ạ", "dạ thưa",
      "chào các bạn", "chào mọi người", "xin chào các bạn", "xin chào mọi người", "chào cả nhà", "xin chào", "well",
      "yeah", "you know", "i mean", "alright"
    ],
    "trail_particles": [
      "ạ", "nhé", "nha", "nhá", "nhỉ", "hả", "đấy", "nhé mọi người", "nha mọi người", "mọi người nhé", "mọi người ạ",
      "các bạn nhé", "các bạn ạ", "anh chị ạ", "anh chị nhé", "thôi", "nhé cả nhà", "okay", "ok"
    ],
    "stutter_words": [
      "cái", "là", "thì", "mà", "và", "của", "cho", "có", "ở", "à", "ờ", "ừ", "tôi", "em", "anh", "chị", "mình",
      "the", "a", "i", "we", "and", "to", "of"
    ],
    "decision_cues": [
      "quyết định", "thống nhất", "chốt", "đồng ý", "phê duyệt", "kết luận", "nhất trí", "duyệt", "chốt lại",
      "đi đến kết luận", "chọn phương án", "agreed", "agree", "decided", "decision", "approved", "concluded",
      "finalized", "sign off", "signed off", "settled on", "resolved", "go ahead with", "we will go with"
    ],
    "negations": [
      "chưa", "không", "chẳng", "khó", "đừng", "chả", "not", "never", "no", "haven't", "hasn't", "didn't", "don't",
      "doesn't", "cannot", "can't", "couldn't", "won't", "wouldn't"
    ],
    "action_strong": [
      "giao cho", "giao việc", "được giao", "phân công", "phụ trách", "đảm nhận", "chịu trách nhiệm",
      "có trách nhiệm", "hoàn thành", "deadline", "hạn chót", "hạn cuối", "đừng quên", "cần phải", "phải", "todo",
      "to do", "action item", "follow up", "must", "have to", "has to", "needs to", "need to", "responsible for",
      "take care of", "assigned", "make sure"
    ],
    "action_weak": [
      "cần", "sẽ", "nên", "gửi", "chuẩn bị", "liên hệ", "liên lạc", "triển khai", "theo dõi", "báo cáo", "kiểm tra",
      "cập nhật", "lên kế hoạch", "lên lịch", "sắp xếp", "bổ sung", "rà soát", "tổng hợp", "trình bày", "nộp", "hẹn",
      "đặt lịch", "xác nhận", "họp lại", "gặp lại", "nhắc", "nhớ", "hoàn thiện", "will", "should", "prepare", "send",
      "deliver", "schedule", "going to", "plan to", "contact", "update", "review", "finish", "complete", "submit",
      "share", "check"
    ],
    "question_starts": [
      "ai", "tại sao", "vì sao", "làm sao", "làm thế nào", "khi nào", "bao giờ", "liệu", "có phải", "có ai", "có nên"
    ],
    "question_ends": [
      "không", "chưa", "hả", "nhỉ", "ư", "chứ", "phải không", "đúng không", "được không", "thế nào", "ra sao"
    ],
    "greeting_cues": [
      "xin chào", "chào mọi người", "chào các bạn", "chào anh chị", "chào cả nhà", "cảm ơn mọi người", "xin cảm ơn",
      "cảm ơn các bạn", "cảm ơn anh chị", "cảm ơn cả nhà", "cám ơn mọi người", "hẹn gặp lại", "chúc mọi người",
      "alo", "a lô", "nghe rõ không", "nghe rõ chưa", "hello everyone", "hi everyone", "good morning",
      "good afternoon", "good evening", "thank you", "thanks everyone", "thanks all", "see you", "goodbye", "bye"
    ],
    "intro_cues": [
      "họp về", "nội dung chính", "mục tiêu", "mục đích", "chủ đề", "chương trình hôm nay", "hôm nay chúng ta",
      "buổi hôm nay", "agenda", "today we", "the goal", "the purpose", "the topic"
    ],
    "conclusion_cues": [
      "tóm lại", "nói tóm lại", "kết luận", "tổng kết", "chốt lại", "như vậy là", "in summary", "to summarize",
      "in conclusion", "to sum up", "overall", "wrap up"
    ],
    "importance_cues": [
      "quan trọng", "lưu ý", "chú ý", "ưu tiên", "mấu chốt", "trọng tâm", "cốt lõi", "rủi ro", "nhấn mạnh",
      "important", "key point", "priority", "critical", "crucial", "note that", "risk"
    ],
    "due_patterns": [
      "ngày (?:mùng |mồng )?[0-9]{1,2}(?:/[0-9]{1,2}(?:/[0-9]{2,4})?|(?: tháng [0-9]{1,2})?(?: năm [0-9]{4})?)",
      "[0-9]{1,2}/[0-9]{1,2}(?:/[0-9]{2,4})?",
      "(?:trước |vào |đến |tới |trong |hết |sáng |chiều |tối )?(?:thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ nhật)(?: tuần (?:sau|tới|này))?",
      "(?:ngày mai|ngày kia|ngày mốt|hôm nay|hôm sau|tối nay|sáng mai|chiều mai|tối mai|trưa mai|chiều nay|sáng nay|tuần sau|tuần tới|tuần này|cuối tuần(?: này| sau| tới)?|đầu tuần(?: sau| tới)?|cuối tháng(?: này| sau| [0-9]{1,2})?|đầu tháng(?: sau| tới| [0-9]{1,2})?|giữa tháng(?: sau| tới| [0-9]{1,2})?|cuối quý(?: [1-4])?|cuối năm(?: nay)?|đầu năm(?: sau| tới)?|tháng sau|tháng tới|năm sau|năm tới|cuối ngày|trong ngày|trong tuần(?: này)?|trong tháng(?: này)?)",
      "(?:tháng [0-9]{1,2}|quý [1-4])(?: năm [0-9]{4}|/[0-9]{4})?",
      "(?:(?:trước|lúc|vào) [0-9]{1,2}(?: giờ|h|g)(?: ?[0-9]{2})?|[0-9]{1,2}h(?:[0-9]{2})?)(?: sáng| chiều| tối| trưa)?(?: mai| nay)?",
      "(?:by |on |before |until |next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
      "(?:by |before |until )?(?:tomorrow|today|tonight|next week|this week|next month|this month|end of (?:the )?(?:week|month|day|quarter|year)|eod|eow|eom|q[1-4])",
      "(?:by |on |before |until )?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec) [0-9]{1,2}(?:st|nd|rd|th)?"
    ],
    "honorifics": [
      "anh", "chị", "em", "bạn", "ông", "bà", "cô", "chú", "bác", "cậu", "thầy", "sếp", "mr", "ms", "mrs", "dr"
    ],
    "org_units": [
      "bộ phận", "phòng", "ban", "nhóm", "team", "đội", "bên", "khối", "tổ"
    ],
    "org_suffixes": [
      "team", "department", "group", "squad", "division"
    ],
    "owner_verbs": [
      "sẽ", "cần", "phải", "nên", "cần phải", "sẽ phải", "phụ trách", "đảm nhận", "chịu trách nhiệm",
      "có trách nhiệm", "will", "should", "must", "shall", "needs to", "need to", "has to", "have to", "is going to",
      "to"
    ],
    "modals": [
      "sẽ", "cần", "phải", "nên", "cần phải", "sẽ phải", "sẽ cần", "will", "should", "must", "shall", "needs to",
      "need to", "has to", "have to", "is going to", "are going to"
    ],
    "subject_pronouns": [
      "tôi", "em", "anh", "chị", "mình", "tớ", "chúng ta", "chúng tôi", "chúng mình", "chúng em", "mọi người",
      "các bạn", "cả nhóm", "i", "we", "you", "they", "everyone"
    ],
    "due_prepositions": [
      "vào", "trước", "đến", "tới", "trong", "hết", "lúc", "by", "on", "before", "until", "at"
    ],
    "not_names": [
      "và", "nhưng", "thì", "nên", "rồi", "sau", "tiếp", "ngoài", "còn", "tuy", "vì", "nếu", "and", "but", "so",
      "then", "also", "because", "however", "tôi", "tao", "tớ", "mình", "ta", "chúng", "họ", "nó", "ai", "mọi",
      "đây", "đó", "này", "việc", "i", "we", "you", "they", "he", "she", "it", "who", "everyone", "someone", "this",
      "that", "there", "the", "cần", "phải", "sẽ", "hãy", "need", "needs", "remember", "please", "try", "want",
      "wants", "going", "let", "lets", "have", "has"
    ],
    "not_names_after_honorific": [
      "nghĩ", "thấy", "muốn", "định", "cũng", "vẫn", "đang", "đã", "có", "là", "không", "chưa", "cần", "phải", "nên",
      "xin", "mong", "hy", "đoán", "tin", "biết", "hiểu", "đề", "nói", "bảo", "hỏi", "xem", "thử", "làm", "đi", "về",
      "ra", "vào", "lên", "xuống", "mới", "vừa", "còn", "lại", "thì", "mà", "này", "đó", "ấy", "kia", "nào", "gì",
      "ai", "đâu", "sao", "ơi", "à", "ạ", "nhé", "cho", "với", "và", "hay", "hoặc", "chắc", "thường", "luôn", "từng",
      "hãy", "đừng", "được", "bị", "rất", "quá", "hơi", "khá", "tự", "cùng", "đều", "chỉ", "cứ", "sắp", "toàn", "sẽ",
      "ở", "của", "trong", "ngoài", "trên", "dưới", "nếu", "vì", "để", "khi", "lúc", "nay", "mai", "gửi", "chuẩn",
      "liên", "kiểm", "báo", "họp", "gặp", "gọi", "nhắn", "lo", "giúp", "nhớ", "quên", "chờ", "đợi"
    ],
    "abbreviations": [
      "tp", "ts", "ths", "gs", "pgs", "bs", "ks", "mr", "mrs", "ms", "dr", "st", "vs", "vd", "tt", "đc", "sđt"
    ],
    "done_markers": [
      "đã", "vừa", "already", "was", "were", "had", "been"
    ],
    "pending_near": [
      "để", "sẽ", "to", "will"
    ],
    "pending_far": [
      "cần", "phải", "chờ", "đợi", "xin", "trình", "need", "needs", "pending", "awaiting", "waiting", "require",
      "requires"
    ],
    "agreement_followers": [
      "với", "with"
    ],
    "decision_lead": [
      "vậy", "thế", "ok", "okay", "rồi", "nên", "thì", "và", "là", "cuối cùng", "sau khi thảo luận",
      "sau khi bàn bạc", "sau khi trao đổi", "như vậy", "như vậy là", "tóm lại", "đã", "cũng", "đều", "cùng", "so",
      "then", "finally", "in the end"
    ],
    "metric_units": [
      "tỷ", "tỉ", "triệu", "nghìn", "ngàn", "trăm", "đồng", "vnd", "vnđ", "usd", "đô", "k", "tr", "percent",
      "dollars", "dollar", "million", "billion", "thousand", "phần", "người", "khách", "đơn", "sản", "cửa", "chiếc",
      "bộ", "giờ", "phút", "ngày", "tuần", "tháng", "năm", "lần", "điểm", "mét", "km", "kg", "tấn", "lít"
    ],
    "gap_words": [
      "thì", "cũng"
    ],
    "decision_subjects": [
      "chúng ta", "chúng tôi", "chúng mình", "mọi người", "cả nhóm", "cả team", "cả phòng", "nhóm", "team",
      "ban lãnh đạo", "ban giám đốc", "hai bên", "các bên", "we", "everyone", "the team", "we all", "both sides"
    ],
    "decision_verbs": [
      "đã thống nhất", "thống nhất là", "thống nhất", "đã đồng ý", "đồng ý là", "đồng ý", "đã quyết định",
      "quyết định là", "quyết định", "đã nhất trí", "nhất trí", "kết luận là", "kết luận", "đã chốt là", "chốt là",
      "chốt lại là", "agreed to", "agreed that", "agreed", "decided to", "decided that", "decided", "concluded that"
    ],
    "labels": {"vi": {"decisions": "Quyết định", "actions": "Việc cần làm", "main": "Ý chính", "meeting": "Cuộc họp"}, "en": {"decisions": "Decisions", "actions": "Action items", "main": "Key points", "meeting": "Meeting"}}
  }/*M2M-DATA-END*/;
  if (typeof module === 'object' && module.exports) module.exports = DATA;
  else root.M2M_ENGINE_DATA = DATA;
})(typeof globalThis !== 'undefined' ? globalThis : this);
