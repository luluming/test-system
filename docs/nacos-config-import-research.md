# Nacos `tenant-config-data/` 配置文件导入系统方案研究

> 研究目标：将 Nacos 服务端 `data/tenant-config-data/` 目录下的配置文件批量导入本系统（Nginx 配置管理系统），给出推荐方案与落地设计。
>
> 2026-11-04 更新：生产环境真实数据已放入 `docs/data/tenant-config-data/`，本文补充真实数据画像（§1.1）与「快速恢复」路径设计（§5）。

## 1. 源数据结构（已验证）

`tenant-config-data` 是 Nacos 服务端的**本地磁盘缓存目录**（用于 MySQL 不可用时的容灾快照），不是控制台导出的 ZIP 格式。Nacos 源码 `DiskUtil.java` 的 `targetFile()` 方法明确定义了路径规则 [cite:1]：

```java
// tenant 为空（public 命名空间）：
{nacos.home}/data/config-data/{group}/{dataId}
// tenant 非空（自定义命名空间）：
{nacos.home}/data/tenant-config-data/{tenant}/{group}/{dataId}
```

因此待导入目录的完整结构为：

```
tenant-config-data/
├── {namespaceId}/            # 一级：命名空间（tenant），如自定义 ID 或 UUID
│   ├── {group}/              # 二级：分组，默认 DEFAULT_GROUP
│   │   ├── {dataId}          # 三级：文件名即 dataId，内容为配置原文
│   │   └── ...
│   └── ...
└── ...
```

- 文件内容即配置原文，编码 UTF-8（`Constants.ENCODE`）[cite:1]。
- 该目录下只有普通配置；beta/tag 灰度配置在独立的 `tenant-beta-data/`、`tenant-tag-data/` 目录，不会混入 [cite:1]。
- 注意：`public` 命名空间（tenant 为空）的配置不在 `tenant-config-data/` 下，而在 `config-data/{group}/{dataId}`，如需一并导入要单独处理 [cite:1][cite:2]。

## 1.1 真实数据画像（生产环境，2026-11-04 实测）

对 `docs/data/tenant-config-data/` 的实测统计：

| 维度 | 实测值 |
|---|---|
| 命名空间（tenant）数 | 30 |
| 配置文件总数 | 194 |
| 总体积 / 最大单文件 | 约 600 KB / 37 KB |
| 路径深度 | 全部为 `{tenant}/{group}/{dataId}` 两级 |
| 文件类型 | 100% `.properties`（Spring Boot 配置） |
| group 特征 | **每个 tenant 下的 group 与 tenant 同名**（Spring Cloud 按应用隔离的约定） |
| dataId 命名 | `{应用名}.properties` 与 `{应用名}_application.properties` 成对出现 |
| 敏感内容 | 85 个文件含 password/secret 类字段（含 RSA 公钥等），属生产敏感数据 |

对本系统落地的三点直接影响：

1. **映射极简**：group 与 tenant 同名 → 无需为 group 单独建模，tenant→项目、dataId→配置名即可，group 记入描述。
2. **配置名安全**：dataId 最长者不超过系统 `name` 100 字符上限，无需截断。
3. **导出可无损还原**：`{tenant}` 即可作为 Nacos 控制台导入 ZIP 的 group 目录名，`{dataId}` 即文件名，控制台导入后自动落到对应 namespace（导入时选择目标命名空间）。

> 安全提示：该目录含生产敏感配置，已纳入仓库工作区但**不应提交到远程仓库**，建议在 `.gitignore` 中忽略 `docs/data/`，导入系统完成后从工作区移除或移出仓库目录。

## 2. Nacos 三级模型 → 本系统模型的映射

Nacos 数据模型为 命名空间（Namespace）→ 分组（Group）→ dataId 三级隔离 [cite:3]；本系统为 行业（Industry）→ 项目（Project）→ 配置（YamlConfig，`(project_id, name)` 唯一）三级。推荐映射：

| Nacos 层级 | 系统落点 | 说明 |
|---|---|---|
| namespaceId (tenant) | **项目**（挂到选定行业下） | 隔离粒度对等；项目名即 tenant 名，冲突则复用已有项目 |
| group | 配置**描述/标签**（或名称前缀 `group__`） | 系统无独立分组层，保留溯源信息即可 |
| dataId | 配置**名称** | 超 100 字符需截断；同项目同名触发冲突策略 |
| 文件内容 | `content_text` | 首次导入自动生成 version=1 版本快照 |
| 文件后缀 | 记入描述 | `.yml/.yaml` 为主；`.properties/.json/.txt` 亦按文本存储 |

## 3. 候选方案对比

| 维度 | A. ZIP 上传 + 后端批量导入接口 | B. 后端扫描服务器本地目录 | C. Python 脚本调现有 API | D. 直连数据库 INSERT |
|---|---|---|---|---|
| 使用门槛 | 浏览器上传即可 | 文件须先放到服务端，且暴露路径读取风险 | 会跑 Python 的运维人员 | 仅 DBA，风险最高 |
| 复用性 | 高（产品化，任何用户可用） | 中 | 低（一次性） | 低 |
| 版本快照/审计 | 完整（走现有 API 语义，created_by 记录） | 可完整 | 完整（走 API） | **缺失**，绕过校验 |
| 冲突处理 | 后端统一：跳过/覆盖成新版本/重命名 | 同左 | 脚本自行处理 409 | 无 |
| 事务与回滚 | 单事务批量，失败整体回滚 + 导入报告 | 同左 | 逐条提交，中断后靠报告续传 | 手工 |
| 开发量 | 后端 ~150 行 + 前端 1 个上传弹窗 | 少但安全性差 | 0（立即可用） | 0 |

结论：**A 为推荐的产品化方案**；若只是本次一次性迁移，可先用 **C** 快速完成，后续再补 A。

## 4. 推荐方案（A）落地设计

### 4.1 交互流程

1. YAML 配置页新增「批量导入」按钮 → 弹窗：选择目标行业 + 上传 ZIP（把 `tenant-config-data/` 目录压缩，或连同其上层的 `config-data/` 一起）。
2. 前端调用 `POST /api/yaml-configs/import-zip`（multipart）。
3. 后端解析 → 预检（冲突/截断/非法名）→ 按冲突策略执行 → 返回导入报告。
4. 弹窗展示报告：成功 N / 跳过 M / 失败 K（含每个 dataId 的原因），完成后刷新列表并派发 `industries:changed`。

### 4.2 解析规则

- 遍历 ZIP 内路径，兼容三种形态（按路径段数自适应）：
  - `tenant-config-data/{tenant}/{group}/{dataId}`（服务端磁盘缓存）
  - `config-data/{group}/{dataId}`（public 命名空间）
  - `{group}/{dataId}`（Nacos 控制台导出 ZIP 的裸格式 [cite:4]）
- 忽略 `.meta.yml` / `meta.json` / 隐藏文件 / `beta~` `tag~` 后缀（灰度数据）。
- dataId 中的 `..`、路径分隔符做安全清洗；名称超 100 字符截断并去重。

### 4.3 冲突策略（弹窗单选）

| 策略 | 行为 |
|---|---|
| 跳过 | 已存在则不动，报告标记 `skipped` |
| 覆盖为新版本 | 调用保存逻辑，内容进 `yaml_config_versions`，可随时回滚（推荐） |
| 重命名导入 | 追加后缀 `-nacos-{group}` |

### 4.4 权限与安全

- 仅项目 owner / admin 可执行导入（复用 `require_project_edit` 体系）；自动建项目时创建人为当前用户。
- ZIP 大小上限（建议 20MB）与文件数上限（建议 500），防止超时；解析在单事务内完成。
- 每 config 记录 `created_by=当前用户`，描述写入来源（`nacos:tenant={tenant},group={group}`），便于回溯。

## 5. 快速恢复路径设计（核心诉求）

「保存到系统中」只是手段，「快速恢复」才是目的。生产 Nacos 故障（MySQL 数据丢失 / 集群不可重建）时，有三条恢复路径，按速度与自动化程度排序：

### 5.1 路径一：导出控制台可导入的 ZIP（推荐，恢复 = 上传一次）

Nacos 控制台原生支持「导入配置（ZIP）」，导入格式为 `{group}/{dataId}` 文件集 [cite:4]。本系统按项目一键导出：

- 新增 `GET /api/projects/{id}/export-nacos-zip`：把项目下全部配置按 `{group}/{dataId}` 打包（group 取自描述中的 `nacos:group=` 溯源字段，即 tenant 名）。
- 恢复操作：Nacos 控制台 → 选择目标命名空间 → 导入 ZIP → 完成。30 个命名空间 = 30 次上传，每次秒级。
- 该路径**零依赖**（不要求旧 Nacos 存活、不要求网络直连），最稳妥。

### 5.2 路径二：系统内直推 Nacos OpenAPI（自动化恢复）

- 新增「恢复推送」：配置 Nacos 地址 + 凭据，选中项目（或全选）批量 `POST /nacos/v1/cs/configs`（dataId/group/tenant/content/type）[cite:5]。
- 适合：新 Nacos 已就绪、想一次性无人值守恢复全部 30 个命名空间。
- 实现：后端异步任务 + 进度报告；失败项可重试。工作量约一个中等接口 + 前端操作页。

### 5.3 路径三：还原服务端磁盘快照（应急，不推荐为主路径）

- 把系统导出的 `tenant-config-data/{tenant}/{group}/{dataId}` 目录树直接拷回 Nacos 服务器 `{nacos.home}/data/` 下再重启。
- 局限：磁盘快照是**读缓存**，Nacos 重启后仍以 MySQL 为准；仅当 MySQL 不可用且 Nacos 未清缓存时能顶住读流量 [cite:2]。只能作为读流量兜底，不能替代 5.1/5.2 的数据回写。

### 5.4 恢复演练建议

- 系统内按项目（=命名空间）组织，天然支持「按应用粒度」的部分恢复。
- 每次导入/修改自动生成 `yaml_config_versions` 版本快照，恢复时可选历史版本。
- 建议每季度用导出 ZIP 在测试 Nacos 做一次导入演练，验证备份可用性。

## 6. 过渡方案（C）脚本要点

不改后端，直接遍历 `docs/data/tenant-config-data/` 调现有 API：

- 建 1 个行业（如「Nacos 配置」）→ 30 个项目（tenant 名）→ 194 个 YAML 配置（dataId 全名，描述记 `nacos:tenant=…,group=…`）。
- token 获取走验证码自动识别流程或临时签发；幂等：项目按名复用，配置同名 409 时改调保存接口生成新版本。
- 结束输出导入报告（成功/跳过/失败清单）。

## 7. 结论

- `tenant-config-data/` 是 Nacos 服务端容灾缓存，结构为 `{tenant}/{group}/{dataId}`，文件内容即配置原文，可放心作为导入源 [cite:1][cite:2]。
- 真实数据 30 命名空间 / 194 个 `.properties`，group 与 tenant 同名，映射极简：**行业「Nacos 配置」→ 30 个项目 → 194 个配置**。
- 落地组合：**先用脚本（方案 C）把现有目录导入系统**，随后补两个恢复能力——「导出 Nacos 控制台 ZIP」（恢复=上传一次）与「直推 OpenAPI 批量恢复」（无人值守）。
- 安全：该目录含生产敏感配置，禁止提交远程仓库；`.gitignore` 忽略 `docs/data/`，导入完成后移出仓库。

## Sources

- [cite:1] Nacos 源码 DiskUtil.java（2.2.0 分支）— https://raw.githubusercontent.com/alibaba/nacos/2.2.0/config/src/main/java/com/alibaba/nacos/config/server/utils/DiskUtil.java
- [cite:2] Nacos配置中心磁盘文件路径说明（CSDN，社区验证）— https://blog.csdn.net/htydowd/article/details/139782184
- [cite:3] Nacos 官方架构文档（数据模型 Namespace/Group/dataId）— https://nacos.io/en/docs/architecture/
- [cite:4] Nacos 1.1.0 发布说明（导入导出 ZIP 格式：group 目录 + dataId 文件）— https://nacos.io/zh-cn/blog/nacos%201.1.0/
- [cite:5] Nacos Open API 指南（发布配置接口）— https://nacos.io/zh-cn/docs/v2/guide/user/open-api.html
