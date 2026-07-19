[CmdletBinding()]
param(
    [string]$RepoRoot = (Join-Path $PSScriptRoot ".."),
    [switch]$LibraryMode
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Resolve-DiaryRepoRoot {
    param([string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath (Join-Path $resolved ".git"))) {
        throw "Gitリポジトリが見つかりません: $resolved"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved "_posts"))) {
        throw "_posts フォルダが見つかりません: $resolved"
    }
    return $resolved.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Invoke-DiaryGit {
    param(
        [string]$Root,
        [string[]]$ArgumentList,
        [switch]$AllowFailure
    )

    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = @(& git -C $Root @ArgumentList 2>&1 | ForEach-Object { $_.ToString() })
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    $result = [pscustomobject]@{
        ExitCode = $exitCode
        Lines = $lines
        Text = ($lines -join [Environment]::NewLine).Trim()
    }

    if (($exitCode -ne 0) -and (-not $AllowFailure)) {
        $commandText = "git " + ($ArgumentList -join " ")
        $details = $result.Text
        if ([string]::IsNullOrWhiteSpace($details)) {
            $details = "終了コード: $exitCode"
        }
        throw "$commandText に失敗しました。`r`n`r`n$details"
    }

    return $result
}

function Get-DiaryGitStatus {
    param([string]$Root)
    $result = Invoke-DiaryGit -Root $Root -ArgumentList @("status", "--porcelain=v1")
    return @($result.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Assert-DiaryGitReady {
    param([string]$Root)

    $branch = (Invoke-DiaryGit -Root $Root -ArgumentList @("branch", "--show-current")).Text
    if ($branch -ne "main") {
        throw "現在のブランチは '$branch' です。日記は main ブランチから公開してください。"
    }

    $status = @(Get-DiaryGitStatus -Root $Root)
    if ($status.Count -gt 0) {
        throw "未保存の変更があるため、日記の公開を停止しました。既存の作業をcommitまたは退避してから、もう一度起動してください。`r`n`r`n$($status -join "`r`n")"
    }
}

function Get-DiaryAheadBehind {
    param([string]$Root)

    $result = Invoke-DiaryGit -Root $Root -ArgumentList @("rev-list", "--left-right", "--count", "HEAD...origin/main")
    $parts = @($result.Text -split "\s+" | Where-Object { $_ -ne "" })
    if ($parts.Count -ne 2) {
        throw "main と origin/main の差分を確認できませんでした: $($result.Text)"
    }
    return [pscustomobject]@{
        Ahead = [int]$parts[0]
        Behind = [int]$parts[1]
    }
}

function Sync-DiaryGit {
    param([string]$Root)

    Assert-DiaryGitReady -Root $Root
    Invoke-DiaryGit -Root $Root -ArgumentList @("fetch", "origin", "main") | Out-Null
    $difference = Get-DiaryAheadBehind -Root $Root

    if (($difference.Ahead -gt 0) -and ($difference.Behind -gt 0)) {
        throw "main と origin/main が分岐しています。安全のため自動公開を停止しました。"
    }
    if ($difference.Ahead -gt 0) {
        throw "まだGitHubへ送られていないcommitがあります。投稿フォームを閉じて再度開き、先に未送信commitを送ってください。"
    }
    if ($difference.Behind -gt 0) {
        Invoke-DiaryGit -Root $Root -ArgumentList @("pull", "--ff-only", "origin", "main") | Out-Null
    }

    Assert-DiaryGitReady -Root $Root
}

function ConvertTo-DiaryRelativePath {
    param(
        [string]$Root,
        [string]$Path
    )

    $rootUri = New-Object System.Uri(($Root.TrimEnd("\") + "\"))
    $pathUri = New-Object System.Uri([System.IO.Path]::GetFullPath($Path))
    return [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString())
}

function ConvertFrom-DiaryWebPath {
    param(
        [string]$Root,
        [string]$WebPath
    )

    if ([string]::IsNullOrWhiteSpace($WebPath)) {
        return $null
    }
    $relative = $WebPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $Root $relative))
    $rootPrefix = $Root.TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "画像パスがリポジトリの外を指しています: $WebPath"
    }
    return $fullPath
}

function ConvertTo-DiaryYamlString {
    param([string]$Value)

    $singleLine = ($Value -replace "[\r\n]+", " ").Trim()
    $escaped = $singleLine.Replace("\", "\\").Replace('"', '\"')
    return '"' + $escaped + '"'
}

function ConvertFrom-DiaryYamlString {
    param([string]$Value)

    $trimmed = $Value.Trim()
    if (($trimmed.Length -ge 2) -and $trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) {
        $trimmed = $trimmed.Substring(1, $trimmed.Length - 2)
        $trimmed = $trimmed.Replace('\"', '"').Replace('\\', '\')
    }
    return $trimmed
}

function Read-DiaryPost {
    param([string]$Path)

    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    $match = [System.Text.RegularExpressions.Regex]::Match(
        $text,
        '\A---\r?\n(?<front>.*?)\r?\n---(?:\r?\n)?(?<body>.*)\z',
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )
    if (-not $match.Success) {
        throw "日記ファイルのfront matterを読み取れません: $Path"
    }

    $fields = @{}
    foreach ($line in ($match.Groups["front"].Value -split "\r?\n")) {
        $fieldMatch = [System.Text.RegularExpressions.Regex]::Match($line, '^([^:]+):\s*(.*)$')
        if ($fieldMatch.Success) {
            $fields[$fieldMatch.Groups[1].Value.Trim()] = ConvertFrom-DiaryYamlString -Value $fieldMatch.Groups[2].Value
        }
    }

    $fileName = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    $slug = "diary"
    if ($fileName.Length -gt 11) {
        $slug = $fileName.Substring(11)
    }

    return [pscustomobject]@{
        Path = $Path
        Slug = $slug
        Date = $fields["date"]
        Image = $fields["image"]
        ImageAlt = $fields["image_alt"]
        Body = $match.Groups["body"].Value.TrimEnd("`r", "`n")
    }
}

function Find-DiaryPostForDate {
    param(
        [string]$Root,
        [datetime]$Date
    )

    $dateText = $Date.ToString("yyyy-MM-dd")
    $matches = @(Get-ChildItem -LiteralPath (Join-Path $Root "_posts") -File -Filter "${dateText}-*.md")
    if ($matches.Count -gt 1) {
        throw "$dateText の日記が複数あります。1日1件に整理してから編集してください。`r`n`r`n$($matches.Name -join "`r`n")"
    }
    if ($matches.Count -eq 0) {
        return $null
    }
    return Read-DiaryPost -Path $matches[0].FullName
}

function New-DiaryMarkdown {
    param(
        [datetime]$Date,
        [string]$Body,
        [string]$ImageWebPath,
        [string]$ImageAlt
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("---")
    $lines.Add("date: $($Date.ToString("yyyy-MM-dd"))")
    if (-not [string]::IsNullOrWhiteSpace($ImageWebPath)) {
        $lines.Add("image: $ImageWebPath")
        $alt = $ImageAlt
        if ([string]::IsNullOrWhiteSpace($alt)) {
            $alt = "$($Date.ToString("yyyy-MM-dd")) の日記画像"
        }
        $lines.Add("image_alt: $(ConvertTo-DiaryYamlString -Value $alt)")
    }
    $lines.Add("---")
    $lines.Add("")
    $lines.Add($Body.Trim())
    return (($lines -join "`n") + "`n")
}

function Get-DiaryMagickCommand {
    $command = Get-Command magick.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command magick -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        throw "画像処理に必要なImageMagick（magick.exe）が見つかりません。"
    }
    return $command.Source
}

function Convert-DiaryImage {
    param(
        [string]$SourcePath,
        [string]$DestinationPath
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "選択した画像が見つかりません: $SourcePath"
    }

    $magick = Get-DiaryMagickCommand
    $arguments = @(
        $SourcePath,
        "-auto-orient",
        "-resize", "1600x1600>",
        "-background", "white",
        "-alpha", "remove",
        "-alpha", "off",
        "-strip",
        "-colorspace", "sRGB",
        "-quality", "85",
        "JPEG:$DestinationPath"
    )
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = @(& $magick @arguments 2>&1 | ForEach-Object { $_.ToString() })
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($exitCode -ne 0) {
        throw "画像をWeb用に変換できませんでした。`r`n`r`n$($output -join "`r`n")"
    }
    if (-not (Test-Path -LiteralPath $DestinationPath -PathType Leaf)) {
        throw "画像変換後のファイルが作成されませんでした。"
    }
}

function Backup-DiaryTarget {
    param(
        [string]$Path,
        [string]$BackupDirectory
    )

    $existed = Test-Path -LiteralPath $Path -PathType Leaf
    $backupPath = $null
    if ($existed) {
        $backupPath = Join-Path $BackupDirectory ([guid]::NewGuid().ToString("N"))
        [System.IO.File]::Copy($Path, $backupPath, $true)
    }
    return [pscustomobject]@{
        Path = $Path
        Existed = $existed
        BackupPath = $backupPath
    }
}

function Restore-DiaryTargets {
    param(
        [string]$Root,
        [object[]]$Backups,
        [string[]]$RelativePaths
    )

    foreach ($backup in $Backups) {
        if ($backup.Existed) {
            [System.IO.File]::Copy($backup.BackupPath, $backup.Path, $true)
        }
        elseif (Test-Path -LiteralPath $backup.Path -PathType Leaf) {
            Remove-Item -LiteralPath $backup.Path -Force
        }
    }

    if ($RelativePaths.Count -gt 0) {
        $arguments = @("restore", "--staged", "--") + $RelativePaths
        Invoke-DiaryGit -Root $Root -ArgumentList $arguments -AllowFailure | Out-Null
    }
}

function Publish-DiaryPost {
    param(
        [string]$Root,
        [datetime]$Date,
        [string]$WeatherSlug,
        [string]$Body,
        [string]$SelectedImagePath,
        [string]$ImageAlt,
        [object]$ExistingPost,
        [switch]$RemoveExistingImage
    )

    if ([string]::IsNullOrWhiteSpace($Body)) {
        throw "本文を入力してください。"
    }
    if (($null -eq $ExistingPost) -and [string]::IsNullOrWhiteSpace($WeatherSlug)) {
        throw "天気を選択してください。"
    }

    Sync-DiaryGit -Root $Root

    $dateText = $Date.ToString("yyyy-MM-dd")
    if ($null -ne $ExistingPost) {
        $postPath = $ExistingPost.Path
        $slug = $ExistingPost.Slug
    }
    else {
        $slug = $WeatherSlug
        $postPath = Join-Path $Root "_posts\${dateText}-${slug}.md"
    }

    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("diary-publisher-" + [guid]::NewGuid().ToString("N"))
    [System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
    $temporaryPost = Join-Path $temporaryDirectory "post.md"
    $temporaryImage = Join-Path $temporaryDirectory "image.jpg"
    $backupDirectory = Join-Path $temporaryDirectory "backup"
    [System.IO.Directory]::CreateDirectory($backupDirectory) | Out-Null

    $imageWebPath = $null
    $newImagePath = $null
    $oldImagePath = $null
    $committed = $false
    $backups = @()
    $relativePaths = @()

    try {
        if (($null -ne $ExistingPost) -and (-not [string]::IsNullOrWhiteSpace($ExistingPost.Image))) {
            $oldImagePath = ConvertFrom-DiaryWebPath -Root $Root -WebPath $ExistingPost.Image
        }

        if (-not [string]::IsNullOrWhiteSpace($SelectedImagePath)) {
            Convert-DiaryImage -SourcePath $SelectedImagePath -DestinationPath $temporaryImage
            $newImagePath = Join-Path $Root "assets\blog\$dateText.jpg"
            $imageWebPath = "/assets/blog/$dateText.jpg"
        }
        elseif ($RemoveExistingImage) {
            $imageWebPath = $null
        }
        elseif ($null -ne $ExistingPost) {
            $imageWebPath = $ExistingPost.Image
            if (($null -ne $oldImagePath) -and (-not (Test-Path -LiteralPath $oldImagePath -PathType Leaf))) {
                throw "既存の日記画像が見つかりません: $($ExistingPost.Image)"
            }
        }

        $markdown = New-DiaryMarkdown -Date $Date -Body $Body -ImageWebPath $imageWebPath -ImageAlt $ImageAlt
        [System.IO.File]::WriteAllText($temporaryPost, $markdown, (New-Object System.Text.UTF8Encoding($false)))

        $touchedPaths = New-Object System.Collections.Generic.List[string]
        $touchedPaths.Add($postPath)
        if ($null -ne $newImagePath) {
            $touchedPaths.Add($newImagePath)
        }
        if (($null -ne $oldImagePath) -and (($RemoveExistingImage) -or (($null -ne $newImagePath) -and ($oldImagePath -ne $newImagePath)))) {
            $touchedPaths.Add($oldImagePath)
        }

        $uniquePaths = @($touchedPaths | Select-Object -Unique)
        foreach ($path in $uniquePaths) {
            $backups += Backup-DiaryTarget -Path $path -BackupDirectory $backupDirectory
        }

        [System.IO.File]::Copy($temporaryPost, $postPath, $true)
        if ($null -ne $newImagePath) {
            [System.IO.File]::Copy($temporaryImage, $newImagePath, $true)
        }
        if (($null -ne $oldImagePath) -and (($RemoveExistingImage) -or (($null -ne $newImagePath) -and ($oldImagePath -ne $newImagePath)))) {
            if (Test-Path -LiteralPath $oldImagePath -PathType Leaf) {
                Remove-Item -LiteralPath $oldImagePath -Force
            }
        }

        $relativePaths = @($uniquePaths | ForEach-Object { ConvertTo-DiaryRelativePath -Root $Root -Path $_ })
        Invoke-DiaryGit -Root $Root -ArgumentList (@("add", "--") + $relativePaths) | Out-Null

        $staged = @(Invoke-DiaryGit -Root $Root -ArgumentList @("diff", "--cached", "--name-only") | Select-Object -ExpandProperty Lines | Where-Object { $_ -ne "" })
        $unexpected = @($staged | Where-Object { $relativePaths -notcontains $_ })
        if ($unexpected.Count -gt 0) {
            throw "投稿対象ではないファイルがstageされたため、公開を中止しました。`r`n`r`n$($unexpected -join "`r`n")"
        }

        if ($staged.Count -eq 0) {
            return [pscustomobject]@{
                Status = "NoChanges"
                Url = "https://umedakouki.github.io/diary/$($Date.ToString("yyyy"))/$($Date.ToString("MM"))/$($Date.ToString("dd"))/$slug/"
                Message = "変更内容はありませんでした。"
            }
        }

        Invoke-DiaryGit -Root $Root -ArgumentList @("commit", "-m", "日記 $dateText") | Out-Null
        $committed = $true

        $pushResult = Invoke-DiaryGit -Root $Root -ArgumentList @("push", "origin", "main") -AllowFailure
        $url = "https://umedakouki.github.io/diary/$($Date.ToString("yyyy"))/$($Date.ToString("MM"))/$($Date.ToString("dd"))/$slug/"
        if ($pushResult.ExitCode -ne 0) {
            return [pscustomobject]@{
                Status = "PushFailed"
                Url = $url
                Message = "日記はローカルにcommitされましたが、GitHubへの送信に失敗しました。`r`n次回起動時に再送できます。`r`n`r`n$($pushResult.Text)"
            }
        }

        return [pscustomobject]@{
            Status = "Published"
            Url = $url
            Message = "日記を公開しました。GitHub Pagesへの反映には少し時間がかかる場合があります。"
        }
    }
    catch {
        if (-not $committed) {
            Restore-DiaryTargets -Root $Root -Backups $backups -RelativePaths $relativePaths
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $temporaryDirectory) {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
        }
    }
}

function Show-DiaryMessage {
    param(
        [string]$Text,
        [string]$Title = "日記を書く",
        [System.Windows.Forms.MessageBoxIcon]$Icon = [System.Windows.Forms.MessageBoxIcon]::Information
    )
    [System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $Icon) | Out-Null
}

function Show-DiaryForm {
    param([string]$Root)

    [System.Windows.Forms.Application]::EnableVisualStyles()

    $weatherToSlug = @{
        "晴れ" = "hare"
        "曇り" = "kumori"
        "雨" = "ame"
        "雪" = "yuki"
        "その他" = "diary"
    }
    $slugToWeather = @{
        "hare" = "晴れ"
        "kumori" = "曇り"
        "ame" = "雨"
        "yuki" = "雪"
        "diary" = "その他"
    }

    $state = [pscustomobject]@{
        ExistingPost = $null
        SelectedImagePath = $null
        CurrentDate = [datetime]::Today
        Populating = $false
        Dirty = $false
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "日記を書く"
    $form.StartPosition = "CenterScreen"
    $form.ClientSize = New-Object System.Drawing.Size(820, 710)
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.Font = New-Object System.Drawing.Font("Yu Gothic UI", 10)

    $heading = New-Object System.Windows.Forms.Label
    $heading.Text = "日記を書く"
    $heading.Font = New-Object System.Drawing.Font("Yu Gothic UI", 16, [System.Drawing.FontStyle]::Bold)
    $heading.AutoSize = $true
    $heading.Location = New-Object System.Drawing.Point(20, 16)
    $form.Controls.Add($heading)

    $dateLabel = New-Object System.Windows.Forms.Label
    $dateLabel.Text = "日付"
    $dateLabel.AutoSize = $true
    $dateLabel.Location = New-Object System.Drawing.Point(22, 62)
    $form.Controls.Add($dateLabel)

    $datePicker = New-Object System.Windows.Forms.DateTimePicker
    $datePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
    $datePicker.CustomFormat = "yyyy年 M月 d日"
    $datePicker.Location = New-Object System.Drawing.Point(72, 58)
    $datePicker.Size = New-Object System.Drawing.Size(180, 30)
    $datePicker.Value = [datetime]::Today
    $form.Controls.Add($datePicker)

    $weatherLabel = New-Object System.Windows.Forms.Label
    $weatherLabel.Text = "天気"
    $weatherLabel.AutoSize = $true
    $weatherLabel.Location = New-Object System.Drawing.Point(275, 62)
    $form.Controls.Add($weatherLabel)

    $weatherBox = New-Object System.Windows.Forms.ComboBox
    $weatherBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    [void]$weatherBox.Items.AddRange([object[]]@("晴れ", "曇り", "雨", "雪", "その他"))
    $weatherBox.Location = New-Object System.Drawing.Point(325, 58)
    $weatherBox.Size = New-Object System.Drawing.Size(125, 30)
    $weatherBox.SelectedIndex = -1
    $form.Controls.Add($weatherBox)

    $postStatus = New-Object System.Windows.Forms.Label
    $postStatus.Text = "新しい日記"
    $postStatus.ForeColor = [System.Drawing.Color]::DimGray
    $postStatus.AutoSize = $true
    $postStatus.Location = New-Object System.Drawing.Point(475, 62)
    $form.Controls.Add($postStatus)

    $bodyLabel = New-Object System.Windows.Forms.Label
    $bodyLabel.Text = "本文（Markdownも使えます）"
    $bodyLabel.AutoSize = $true
    $bodyLabel.Location = New-Object System.Drawing.Point(22, 103)
    $form.Controls.Add($bodyLabel)

    $bodyBox = New-Object System.Windows.Forms.TextBox
    $bodyBox.Multiline = $true
    $bodyBox.AcceptsReturn = $true
    $bodyBox.AcceptsTab = $true
    $bodyBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $bodyBox.Location = New-Object System.Drawing.Point(24, 130)
    $bodyBox.Size = New-Object System.Drawing.Size(772, 350)
    $form.Controls.Add($bodyBox)

    $imageLabel = New-Object System.Windows.Forms.Label
    $imageLabel.Text = "画像（任意）"
    $imageLabel.AutoSize = $true
    $imageLabel.Location = New-Object System.Drawing.Point(22, 502)
    $form.Controls.Add($imageLabel)

    $selectImageButton = New-Object System.Windows.Forms.Button
    $selectImageButton.Text = "画像を選択..."
    $selectImageButton.Location = New-Object System.Drawing.Point(24, 530)
    $selectImageButton.Size = New-Object System.Drawing.Size(125, 34)
    $form.Controls.Add($selectImageButton)

    $imageStatus = New-Object System.Windows.Forms.Label
    $imageStatus.Text = "画像なし"
    $imageStatus.AutoEllipsis = $true
    $imageStatus.Location = New-Object System.Drawing.Point(165, 537)
    $imageStatus.Size = New-Object System.Drawing.Size(445, 24)
    $form.Controls.Add($imageStatus)

    $removeImage = New-Object System.Windows.Forms.CheckBox
    $removeImage.Text = "既存画像を削除"
    $removeImage.AutoSize = $true
    $removeImage.Location = New-Object System.Drawing.Point(640, 536)
    $removeImage.Enabled = $false
    $form.Controls.Add($removeImage)

    $altLabel = New-Object System.Windows.Forms.Label
    $altLabel.Text = "画像の説明"
    $altLabel.AutoSize = $true
    $altLabel.Location = New-Object System.Drawing.Point(22, 585)
    $form.Controls.Add($altLabel)

    $altBox = New-Object System.Windows.Forms.TextBox
    $altBox.Location = New-Object System.Drawing.Point(120, 581)
    $altBox.Size = New-Object System.Drawing.Size(676, 28)
    $form.Controls.Add($altBox)

    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = "画像は自動で長辺1600pxのJPEGに変換し、位置情報などのメタデータを削除します。"
    $hint.ForeColor = [System.Drawing.Color]::DimGray
    $hint.AutoSize = $true
    $hint.Location = New-Object System.Drawing.Point(22, 620)
    $form.Controls.Add($hint)

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = "キャンセル"
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancelButton.Location = New-Object System.Drawing.Point(575, 657)
    $cancelButton.Size = New-Object System.Drawing.Size(105, 36)
    $form.Controls.Add($cancelButton)

    $publishButton = New-Object System.Windows.Forms.Button
    $publishButton.Text = "確認して公開"
    $publishButton.Location = New-Object System.Drawing.Point(692, 657)
    $publishButton.Size = New-Object System.Drawing.Size(105, 36)
    $form.Controls.Add($publishButton)
    $form.AcceptButton = $publishButton
    $form.CancelButton = $cancelButton

    $loadDate = {
        param([datetime]$NewDate)

        $state.Populating = $true
        try {
            $post = Find-DiaryPostForDate -Root $Root -Date $NewDate
            $state.ExistingPost = $post
            $state.SelectedImagePath = $null
            $state.CurrentDate = $NewDate.Date
            $removeImage.Checked = $false
            $bodyBox.Clear()
            $altBox.Clear()

            if ($null -ne $post) {
                $postStatus.Text = "既存の日記を編集中: $([System.IO.Path]::GetFileName($post.Path))"
                $bodyBox.Text = $post.Body
                $altBox.Text = $post.ImageAlt
                if ($slugToWeather.ContainsKey($post.Slug)) {
                    $weatherBox.SelectedItem = $slugToWeather[$post.Slug]
                }
                else {
                    $weatherBox.SelectedItem = "その他"
                }
                $weatherBox.Enabled = $false
                if (-not [string]::IsNullOrWhiteSpace($post.Image)) {
                    $imageStatus.Text = "既存画像: $($post.Image)"
                    $removeImage.Enabled = $true
                }
                else {
                    $imageStatus.Text = "画像なし"
                    $removeImage.Enabled = $false
                }
            }
            else {
                $postStatus.Text = "新しい日記"
                $weatherBox.Enabled = $true
                $weatherBox.SelectedIndex = -1
                $imageStatus.Text = "画像なし"
                $removeImage.Enabled = $false
            }
            $state.Dirty = $false
        }
        finally {
            $state.Populating = $false
        }
    }

    $markDirty = {
        if (-not $state.Populating) {
            $state.Dirty = $true
        }
    }
    $bodyBox.Add_TextChanged($markDirty)
    $altBox.Add_TextChanged($markDirty)
    $weatherBox.Add_SelectedIndexChanged($markDirty)

    $datePicker.Add_ValueChanged({
        if ($state.Populating) {
            return
        }
        $requestedDate = $datePicker.Value.Date
        if (($requestedDate -ne $state.CurrentDate) -and $state.Dirty) {
            $choice = [System.Windows.Forms.MessageBox]::Show(
                "入力中の内容を破棄して、別の日付へ移動しますか？",
                "日付を変更",
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Question
            )
            if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
                $state.Populating = $true
                $datePicker.Value = $state.CurrentDate
                $state.Populating = $false
                return
            }
        }
        try {
            & $loadDate $requestedDate
        }
        catch {
            Show-DiaryMessage -Text $_.Exception.Message -Icon Error
            $state.Populating = $true
            $datePicker.Value = $state.CurrentDate
            $state.Populating = $false
        }
    })

    $selectImageButton.Add_Click({
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = "日記に載せる画像を選択"
        $dialog.Filter = "画像ファイル|*.jpg;*.jpeg;*.png;*.heic;*.webp;*.tif;*.tiff;*.bmp|すべてのファイル|*.*"
        $dialog.Multiselect = $false
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            $state.SelectedImagePath = $dialog.FileName
            $removeImage.Checked = $false
            $imageStatus.Text = "選択中: $([System.IO.Path]::GetFileName($dialog.FileName))"
            $state.Dirty = $true
        }
        $dialog.Dispose()
    })

    $removeImage.Add_CheckedChanged({
        if ($state.Populating) {
            return
        }
        if ($removeImage.Checked) {
            $state.SelectedImagePath = $null
            $imageStatus.Text = "公開時に既存画像を削除します"
        }
        elseif (($null -ne $state.ExistingPost) -and (-not [string]::IsNullOrWhiteSpace($state.ExistingPost.Image))) {
            $imageStatus.Text = "既存画像: $($state.ExistingPost.Image)"
        }
        else {
            $imageStatus.Text = "画像なし"
        }
        $state.Dirty = $true
    })

    $publishButton.Add_Click({
        try {
            if ([string]::IsNullOrWhiteSpace($bodyBox.Text)) {
                throw "本文を入力してください。"
            }
            if (($null -eq $state.ExistingPost) -and ($weatherBox.SelectedIndex -lt 0)) {
                throw "天気を選択してください。"
            }

            $weatherSlug = $null
            if ($null -eq $state.ExistingPost) {
                $weatherSlug = $weatherToSlug[$weatherBox.SelectedItem.ToString()]
                $targetName = "$($datePicker.Value.ToString("yyyy-MM-dd"))-$weatherSlug.md"
            }
            else {
                $targetName = [System.IO.Path]::GetFileName($state.ExistingPost.Path)
            }

            $imageSummary = "画像なし"
            if (-not [string]::IsNullOrWhiteSpace($state.SelectedImagePath)) {
                $imageSummary = "画像をWeb用JPEGに変換: $([System.IO.Path]::GetFileName($state.SelectedImagePath))"
            }
            elseif ($removeImage.Checked) {
                $imageSummary = "既存画像を削除"
            }
            elseif (($null -ne $state.ExistingPost) -and (-not [string]::IsNullOrWhiteSpace($state.ExistingPost.Image))) {
                $imageSummary = "既存画像を維持: $($state.ExistingPost.Image)"
            }

            $preview = ($bodyBox.Text.Trim() -replace "\s+", " ")
            if ($preview.Length -gt 180) {
                $preview = $preview.Substring(0, 180) + "…"
            }
            $confirmation = "次の内容をGitHubへ公開します。`r`n`r`n日付: $($datePicker.Value.ToString("yyyy-MM-dd"))`r`nファイル: _posts/$targetName`r`n$imageSummary`r`n`r`n本文:`r`n$preview"
            $choice = [System.Windows.Forms.MessageBox]::Show(
                $confirmation,
                "公開内容の確認",
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Question
            )
            if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
                return
            }

            $publishButton.Enabled = $false
            $form.UseWaitCursor = $true
            [System.Windows.Forms.Application]::DoEvents()

            $publishArguments = @{
                Root = $Root
                Date = $datePicker.Value.Date
                WeatherSlug = $weatherSlug
                Body = $bodyBox.Text
                SelectedImagePath = $state.SelectedImagePath
                ImageAlt = $altBox.Text
                ExistingPost = $state.ExistingPost
                RemoveExistingImage = $removeImage.Checked
            }
            $result = Publish-DiaryPost @publishArguments

            if ($result.Status -eq "PushFailed") {
                Show-DiaryMessage -Text $result.Message -Title "GitHubへの送信に失敗" -Icon Warning
                $form.Close()
                return
            }
            if ($result.Status -eq "NoChanges") {
                Show-DiaryMessage -Text $result.Message
                return
            }

            $openChoice = [System.Windows.Forms.MessageBox]::Show(
                "$($result.Message)`r`n`r`n公開ページをブラウザで開きますか？`r`n$result.Url",
                "公開しました",
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Information
            )
            if ($openChoice -eq [System.Windows.Forms.DialogResult]::Yes) {
                Start-Process $result.Url
            }
            $form.Close()
        }
        catch {
            Show-DiaryMessage -Text $_.Exception.Message -Title "公開できませんでした" -Icon Error
        }
        finally {
            $publishButton.Enabled = $true
            $form.UseWaitCursor = $false
        }
    })

    & $loadDate ([datetime]::Today)
    $bodyBox.Focus()
    [void]$form.ShowDialog()
    $form.Dispose()
}

function Start-DiaryPublisher {
    try {
        $root = Resolve-DiaryRepoRoot -Path $RepoRoot
        Assert-DiaryGitReady -Root $root

        $difference = Get-DiaryAheadBehind -Root $root
        if (($difference.Ahead -gt 0) -and ($difference.Behind -eq 0)) {
            $choice = [System.Windows.Forms.MessageBox]::Show(
                "前回GitHubへ送れなかったcommitが $($difference.Ahead) 件あります。先に再送しますか？",
                "未送信の日記",
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            )
            if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
                return
            }
            $push = Invoke-DiaryGit -Root $root -ArgumentList @("push", "origin", "main") -AllowFailure
            if ($push.ExitCode -ne 0) {
                throw "未送信commitをGitHubへ送れませんでした。`r`n`r`n$($push.Text)"
            }
        }
        elseif (($difference.Ahead -gt 0) -and ($difference.Behind -gt 0)) {
            throw "main と origin/main が分岐しています。安全のため投稿フォームを開始できません。"
        }

        Show-DiaryForm -Root $root
    }
    catch {
        Show-DiaryMessage -Text $_.Exception.Message -Title "日記を書く" -Icon Error
        exit 1
    }
}

if (-not $LibraryMode) {
    Start-DiaryPublisher
}
