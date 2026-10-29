# MySQL 切换说明

本项目原以 SQLite 作为本地开发数据库，现已支持 MySQL 作为生产数据库。SQLAlchemy 2.0
作为 ORM，两种后端切换只需要改一个环境变量，模型与业务代码通用。

## 快速切换（三步）

### 1. 在 MySQL 上建库 + 授权

```sql
-- backend/scripts/mysql_init.sql
CREATE DATABASE IF NOT EXISTS test_system
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'testapp'@'localhost' IDENTIFIED BY 'CHANGE_ME';
GRANT ALL PRIVILEGES ON test_system.* TO 'testapp'@'localhost';
FLUSH PRIVILEGES;
```

### 2. 导入现有 SQLite 数据

```bash
cd backend
# 先让 SQLAlchemy 用 MySQL 建表（第一次用 MySQL 跑 seed 会自动 create_all）
DATABASE_URL='mysql+pymysql://testapp:CHANGE_ME@127.0.0.1:3306/test_system?charset=utf8mb4' \
  python3 -m uvicorn app.main:app --port 8001   # 首次启动让 create_all 建表，Ctrl+C 停掉

# 再跑迁移脚本把 SQLite 数据灌进去
python3 -m scripts.sqlite_to_mysql \
  --sqlite ./test_system.db \
  --mysql  "mysql+pymysql://testapp:CHANGE_ME@127.0.0.1:3306/test_system?charset=utf8mb4"
```

脚本特性：
- 事务内全量导入，单张表失败整体回滚
- 自动按外键拓扑序写入（users → industries → nginx/yaml → blocks/upstreams → push_tasks）
- 默认拒绝覆盖非空目标库，`--overwrite` 强制清表重灌
- 导入后逐表校验行数

### 3. 切 DATABASE_URL

把 `backend/.env` 最后一行改成 MySQL 串，重启后端即可：

```bash
# backend/.env
DATABASE_URL=mysql+pymysql://testapp:CHANGE_ME@127.0.0.1:3306/test_system?charset=utf8mb4
```

## 回滚到 SQLite

只把 `.env` 里 `DATABASE_URL` 改回 `sqlite:///./test_system.db`，重启后端就行——后端自动识别 URL 前缀决定 engine 参数（SQLite 用 `check_same_thread=False`，MySQL 用 `pool_size/pool_recycle/pool_pre_ping + utf8mb4`）。

## 兼容性说明

所有 ORM 模型（`app/models/*.py`）只使用 SQLAlchemy 2.0 跨后端类型：
`String / Text / Boolean / DateTime / ForeignKey`，不依赖 SQLite 专有语法
（如 `INTEGER PRIMARY KEY AUTOINCREMENT`、`PRAGMA`）。

唯一的「迁移型」逻辑是 `_ensure_scope_column()`（`ALTER TABLE industries ADD COLUMN scope`），
SQLAlchemy `inspect` + `text()` 在 SQLite/MySQL/PostgreSQL 上均可用。

## 新增依赖

```
pymysql>=1.1   # SQLAlchemy 通过 mysql+pymysql:// 连接 MySQL
```
