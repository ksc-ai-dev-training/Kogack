@echo off
setlocal
cd /d %~dp0

rem ==== Load .env (KEY=VALUE, lines starting with # are comments) ====
if not exist .env (
    echo .env not found - copying from .env.example
    copy /y .env.example .env >nul
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
if not defined DB_PORT set DB_PORT=55433
if not defined BACKEND_PORT set BACKEND_PORT=8011
if not defined FRONTEND_PORT set FRONTEND_PORT=5174
if not defined DB_MODE set DB_MODE=auto
if not defined DOCKER_DESKTOP set "DOCKER_DESKTOP=C:\Program Files\Docker\Docker\Docker Desktop.exe"
echo [Kogack] ports: DB=%DB_PORT% / backend=%BACKEND_PORT% / frontend=%FRONTEND_PORT%

rem ==== Detect a locally installed PostgreSQL service (any version) ====
if not defined PG_SERVICE (
    for /f "tokens=2" %%S in ('sc query state^= all ^| findstr /i /c:"SERVICE_NAME: postgresql"') do set "PG_SERVICE=%%S"
)

rem ==== Pick the database backend: docker / local / auto ====
if /i "%DB_MODE%"=="docker" goto mode_docker
if /i "%DB_MODE%"=="local"  goto mode_local
if /i not "%DB_MODE%"=="auto" (
    echo ERROR: invalid DB_MODE "%DB_MODE%" in .env - use auto, docker or local.
    exit /b 1
)
rem auto: a local PostgreSQL service wins, otherwise fall back to Docker
if defined PG_SERVICE goto mode_local
where docker >nul 2>&1
if not errorlevel 1 goto mode_docker
echo ERROR: no database backend found.
echo        Install PostgreSQL locally, or install Docker Desktop, then retry.
exit /b 1

rem ============================================================
rem  Local PostgreSQL service
rem ============================================================
:mode_local
if not defined PG_SERVICE (
    echo ERROR: DB_MODE=local but no PostgreSQL service was found.
    echo        Install PostgreSQL, or set PG_SERVICE in .env to the service name.
    exit /b 1
)
echo [Kogack] database: local PostgreSQL service "%PG_SERVICE%"
sc query "%PG_SERVICE%" | find "RUNNING" >nul
if errorlevel 1 (
    echo Starting %PG_SERVICE% ...
    net start "%PG_SERVICE%" >nul 2>&1
    if errorlevel 1 echo WARNING: could not start the service - administrator rights may be required.
)
goto db_ready

rem ============================================================
rem  PostgreSQL in Docker (container kogack-db)
rem ============================================================
:mode_docker
echo [Kogack] database: Docker container kogack-db
where docker >nul 2>&1
if errorlevel 1 (
    echo ERROR: the docker command was not found.
    echo        Install Docker Desktop, or set DB_MODE=local in .env to use a local PostgreSQL.
    exit /b 1
)
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
if not exist "%DOCKER_DESKTOP%" (
    echo ERROR: the Docker engine is not running and Docker Desktop was not found at:
    echo        %DOCKER_DESKTOP%
    echo        Start Docker Desktop manually, set DOCKER_DESKTOP in .env,
    echo        or set DB_MODE=local in .env to use a local PostgreSQL.
    exit /b 1
)
echo Starting Docker Desktop...
start "" "%DOCKER_DESKTOP%"
set /a _tries=0
:wait_docker
ping -n 4 127.0.0.1 >nul 2>&1
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
set /a _tries+=1
if %_tries% lss 30 goto wait_docker
echo ERROR: timed out waiting for Docker. Start Docker Desktop and retry,
echo        or set DB_MODE=local in .env to use a local PostgreSQL.
exit /b 1
:docker_ready

rem ==== PostgreSQL container (create if missing) ====
docker start kogack-db >nul 2>&1
if errorlevel 1 (
    echo Creating kogack-db container...
    docker run -d --name kogack-db -e POSTGRES_PASSWORD=kogack -e POSTGRES_USER=kogack -e POSTGRES_DB=kogack -p %DB_PORT%:5432 postgres:16
)
goto db_ready

:db_ready
set DATABASE_URL=postgresql://kogack:kogack@localhost:%DB_PORT%/kogack

rem ==== Seed data (waits for DB startup; skipped when data already exists) ====
set /a _stries=0
:seed
pushd backend
.venv\Scripts\python.exe seed.py >nul 2>&1
set _seed_result=%errorlevel%
popd
if %_seed_result%==0 goto seed_done
set /a _stries+=1
if %_stries% geq 10 (
    echo WARNING: seeding failed. Run backend\seed.py manually to see the error.
    echo          With DB_MODE=local, check that the kogack role/database exist
    echo          and that PostgreSQL listens on port %DB_PORT%.
    goto seed_done
)
ping -n 3 127.0.0.1 >nul 2>&1
goto seed
:seed_done

rem ==== Launch backend / frontend in separate windows ====
start "kogack-backend :%BACKEND_PORT%" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn main:app --port %BACKEND_PORT% --reload"
start "kogack-frontend :%FRONTEND_PORT%" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Kogack started: http://localhost:%FRONTEND_PORT%/
echo (If FRONTEND_PORT was busy, open the port shown in the Vite window instead)
endlocal
