# Публикация AngelTime v0.4.22 на GitHub

Рекомендуемый репозиторий: `TraurigerEngel/AngelTime`. Выпуск: `v0.4.22`.

Прямое создание репозитория/релиза через подключённый GitHub-инструмент в этой беседе недоступно. Скрипт публикации предназначен для запуска на **вашем Windows 11** в GitHub CLI под **вашим аккаунтом**, без передачи пароля или токена в чат.

1. Убедитесь, что стоят Git for Windows и GitHub CLI. При необходимости:

   ```powershell
   winget install --id Git.Git -e
   winget install --id GitHub.cli -e
   ```

2. Один раз авторизуйтесь в GitHub CLI:

   ```powershell
   gh auth login -h github.com -w
   ```

3. Распакуйте релизный комплект, откройте папку `AngelTime_v0.4.22_Source` и запустите:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\PUBLISH-TO-GITHUB.ps1
   ```

Скрипт проверит SHA-256 исходников, выполнит 39 JS-тестов, 21 Rust-тест и Windows Release-сборку, затем создаст **приватный** GitHub-репозиторий и публикацию с тремя вложениями: Portable EXE, его SHA-256 и ZIP исходников. GitHub CLI может потребовать интерактивную авторизацию в браузере.

**Публичный репозиторий:** прежде подтвердите ваши права на `default_alarm.mp3`, затем вместо команды выше используйте:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\PUBLISH-TO-GITHUB.ps1 -Visibility public -ConfirmAudioRights
```

Скрипт НЕ перезаписывает существующий удалённый репозиторий и НЕ меняет ваш рабочий проект в `T:\Downloads\Projjj\AngelTime_v0.4.0`.

Если процесс остановится после создания репозитория, не запускайте скрипт вслепую повторно: сначала проверьте состояние в GitHub. Файл `PUBLISH-TO-GITHUB.ps1` не реализует удалённого отката созданного репозитория.
