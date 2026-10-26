# 新建行业（模板克隆，模板源可选）设计

日期：2026-10-26
状态：已确认

## 背景

现有「新建行业（模板克隆）」要求必选模板源行业，深拷贝其整套配置。新需求：

- 模板源行业为**可选**下拉，不选模板也能创建空行业。
- 克隆后与源完全独立（数据全为新建记录）。
- 深拷贝范围补充**镜像对**；版本快照/推送记录不拷（新配置从 version 1 干净开始）。

## 后端

### 1. Schema：`CloneIndustryRequest`

`backend/app/schemas/industry.py`：`source_industry_id: int | None = None`（可选）。

### 2. Service：`clone_industry`

`backend/app/services/industry_clone.py`：

- `source_industry_id` 为空：仅创建空行业 `Industry(code=derive_code(name) 或手填 code, name, owner, is_template=False, cloned_from_id=None)`，不拷贝任何数据。
- 有模板源：走现有深拷贝（nginx_configs + config_blocks 树 + config_options + upstreams + upstream_servers + domain_mappings + forward_ports + biz_ports），并**新增拷贝 NginxMirrorPair**：按源 config 的 `nginx_config_id` 逐条拷贝 `src_listen/dst_listen`，通过旧 config id → 新 config id 映射指向新配置。
- 手填 code：空行业模式下若调用方传入 `code` 则直接使用，否则自动派生。

### 3. 路由

`POST /api/industries/clone` 不变；`source_industry_id` 为空时不再校验源存在；名称/code 冲突仍 409。

## 前端

### 4. `IndustryCloneModal.jsx`

- 「模板源行业」下拉**可选**：`value=""` 表示不选。
- 新增可选「行业 code」输入框：留空自动生成（仅创建空行业模式传递）。
- 提交条件：新行业名称非空即可。
- 提交逻辑：选中模板 → `cloneIndustry({ source_industry_id, name, owner, code })`；未选 → `cloneIndustry({ name, owner, code })`（不带 source_industry_id）。
- 按钮文案：选中模板「创建并克隆」/ 未选「创建空行业」。
- meta 提示文案同步更新。

### 5. `api/industry.js`

`cloneIndustry(data)` 不变（透传 body）。

## 独立性保证

克隆产生的所有行（config/block/option/upstream/mirror pair 等）均为新记录，指向新行业与新建配置；编辑克隆行业不影响源行业。

## 验证

1. 不选模板创建空行业：成功，无任何配置数据，`cloned_from_id` 为空。
2. 选模板克隆：配置/块/选项/镜像对齐全，`cloned_from_id` 指向源。
3. 修改源行业后，克隆行业不受影响；修改克隆后源不受影响。
