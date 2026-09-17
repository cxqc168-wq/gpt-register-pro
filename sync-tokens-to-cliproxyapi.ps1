# ============================================================
#  sync-tokens-to-cliproxyapi.ps1
#  把本机 ChatGPT/Codex OAuth token（tokens\codex-*.json）
#  同步到 CLIProxyAPI 的 auth-dir，让 antigemini 代理直接使用这些账号。
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File sync-tokens-to-cliproxyapi.ps1
#    参数：
#      -TokenDir   token 来源目录，默认 .\tokens
#      -AuthDir    CLIProxyAPI auth-dir，默认 C:\Users\18430\.cli-proxy-api
#      -Force      覆盖 auth-dir 中已存在的同名文件
#
#  说明：
#    - token 文件会被重命名为 codex-<邮箱>.json（与 auth-dir 现有
#      antigravity-<邮箱>.json 命名规范一致），type 字段(="codex")
#      决定 CLIProxyAPI 把它注册为 Codex OAuth 账号。
#    - 复制完成后需要让服务加载新凭据：
#        方式1：重启服务（一键启动项目.bat restart）
#        方式2：在管理页 http://localhost:8317/management.html#/auth-files
#               里点上传（上传后无需重启）
#        方式3：管理 API 上传（见注释末尾的 curl 示例）
# ============================================================

param(
    [string]$TokenDir = ".\tokens",
    [string]$AuthDir  = "C:\Users\18430\.cli-proxy-api",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $TokenDir)) { Write-Error "token 目录不存在: $TokenDir"; exit 1 }
if (-not (Test-Path $AuthDir))  { Write-Error "auth-dir 不存在: $AuthDir"; exit 1 }

$srcDir = (Resolve-Path $TokenDir).Path
$dstDir = (Resolve-Path $AuthDir).Path

$files = Get-ChildItem -Path $srcDir -Filter "codex-*.json" -File
if ($files.Count -eq 0) {
    Write-Host "[提示] $srcDir 下没有 codex-*.json token 文件。" -ForegroundColor Yellow
    Write-Host "       先运行 node index.js <数量> 生成 token，再执行本脚本。"
    exit 0
}

Write-Host "== 同步 Codex token 到 CLIProxyAPI auth-dir ==" -ForegroundColor Cyan
Write-Host "来源: $srcDir"
Write-Host "目标: $dstDir"
Write-Host ""

$copied = 0
foreach ($f in $files) {
    $json = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $email = $json.email
    if (-not $email) {
        # 兜底：从文件名 codex-<xxx>(-free).json 里取
        $m = [regex]::Match($f.BaseName, '^codex-(.+?)(-free)?$')
        $email = if ($m.Success) { $m.Groups[1].Value } else { $f.BaseName }
    }
    if (-not $email) {
        Write-Warning "跳过 $($f.Name)：无法识别 email。"
        continue
    }
    # 邮箱中的 @ 保留即可（现有 antigravity-xxx@gmail.com.json 也是这种命名）
    $target = Join-Path $dstDir ("codex-{0}.json" -f $email)
    if ((Test-Path $target) -and -not $Force) {
        Write-Host "[跳过] $target 已存在（用 -Force 覆盖）" -ForegroundColor DarkGray
        continue
    }
    Copy-Item $f.FullName $target -Force
    $copied++
    Write-Host "[复制] $($f.Name) -> $(Split-Path $target -Leaf)" -ForegroundColor Green
}

Write-Host ""
Write-Host "== 完成：共导入 $copied 个账号 ==" -ForegroundColor Cyan
if ($copied -eq 0) { exit 0 }

Write-Host ""
Write-Host "下一步（任选其一让服务加载新账号）：" -ForegroundColor Yellow
Write-Host "  1) 重启服务： D:\My_Codeproject\antigemini\一键启动项目.bat restart"
Write-Host "  2) 管理页上传：打开 http://localhost:8317/management.html#/auth-files，上传上面列出的 JSON 文件（无需重启）"
Write-Host "  3) 管理 API：curl -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer <管理密钥>' --data-binary @<文件> 'http://localhost:8317/v0/management/auth-files?name=codex-<邮箱>.json'"
Write-Host ""
Write-Host "验证：打开 http://localhost:8317/management.html#/auth-files 应能看到 codex-<邮箱> 条目；"
Write-Host "      再用 API key 调一次: curl http://localhost:8317/v1/models -H 'Authorization: Bearer <API key>'"
