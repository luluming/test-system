"""API 路由包。

注意：不在包级重导出路由，避免与 core.security 产生循环导入
（security -> api.deps -> api 包初始化 -> auth -> security）。
路由统一由 app.main 直接导入子模块。
"""
