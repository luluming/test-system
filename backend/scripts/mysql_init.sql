-- MySQL 初始化：创建数据库 + 应用账号（只需要跑一次）
-- 之后就可以把 backend/.env 的 DATABASE_URL 改成下方连接串

CREATE DATABASE IF NOT EXISTS test_system
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- 只给本机访问（生产建议改 '%' 或指定 IP）
CREATE USER IF NOT EXISTS 'testapp'@'localhost' IDENTIFIED BY 'CHANGE_ME';
GRANT ALL PRIVILEGES ON test_system.* TO 'testapp'@'localhost';
FLUSH PRIVILEGES;

-- 如果 root 也要直接用：
-- ALTER USER 'root'@'localhost' IDENTIFIED BY 'YOUR_ROOT_PASS';

-- 验证
USE test_system;
SHOW TABLES;
