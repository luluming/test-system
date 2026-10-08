"""pytest 共享夹具：临时 SQLite 数据库 + 覆盖 get_db 的 TestClient。"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.deps import get_db
from app.core.captcha import generate_captcha
from app.main import app
from app.models import Base


@pytest.fixture()
def db_session_factory(tmp_path):
    """创建指向临时 SQLite 文件的引擎与会话工厂，并完成建表。"""
    db_file = tmp_path / "test.db"
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    testing_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    yield testing_session
    engine.dispose()


@pytest.fixture()
def client(db_session_factory):
    """提供覆盖 get_db 依赖的 TestClient，各用例数据库互不影响。"""

    def override_get_db():
        db: Session = db_session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture()
def auth_headers(client):
    """注册并登录测试用户，返回可直接使用的 Authorization 请求头。"""
    username = "tester"
    password = "testpass123"
    resp = client.post(
        "/api/auth/register",
        json={"username": username, "email": "tester@example.com", "password": password},
    )
    assert resp.status_code == 201
    captcha = generate_captcha()
    login = client.post(
        "/api/auth/login",
        json={
            "username": username,
            "password": password,
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
        },
    )
    assert login.status_code == 200
    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}
