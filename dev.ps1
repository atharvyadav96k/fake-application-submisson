$root = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\Backend'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\Frontend'; npm run dev"
