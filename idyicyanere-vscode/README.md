# Idyicyanere
by: waajacu.com

Idyicyanere is a VS Code extension that helps you edit a codebase with AI, safely and with good context.

- Pick files/folders you want the AI to consider (keyboard-friendly).
- Dump context from those paths into a clean snapshot for prompting.
- Plan changes from a natural language request into a concrete set of edits.
- Review diffs and apply changes with clear state and logs.

The focus is simple: better context in, clearer edits out, and you stay in control.

# build the app in Linux
```bash
chmod +x setup-linux.sh
./setup-linux.sh
```
# build the app in Windows

First start a container, to avoid installing a lot of things in the host
```PowerShell
cd /path/to/idyicyanere-vscode
docker run --rm -it --name idyicyanere_win -v "%cd%:C:\idyicyanere" -w "C:\idyicyanere" mcr.microsoft.com/windows/servercore:ltsc2022 powershell
docker exec -it idyicyanere_win powershell
```

Now inside the docker make the installation
```PowerShell
.\win-setup.ps1
```

# Install the App
In VS Code: press Ctrl+Shift+P → run "Extensions: Install from VSIX…" → pick dist-vsix/idyicyanere-win32-x64.vsix. or do:

```
code --install-extension dist-vsix\idyicyanere-win32-x64.vsix
```

