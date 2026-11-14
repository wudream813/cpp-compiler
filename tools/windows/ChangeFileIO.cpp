#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <ctime>

#include <cctype>
#include <string>
#include <algorithm>

bool isConsoleFile(const char* path) {
    if (!path || !*path) return false;
    std::string p(path);
    std::string lower = p;
    for (char &c : lower) c = std::tolower((unsigned char)c);
    if (lower == "con" || lower == "conin$" || lower == "conout$" || lower == "nul" || lower == "aux" || lower == "prn") return true;
    if (lower == "/dev/stdin" || lower == "/dev/stdout" || lower == "/dev/stderr" || lower == "/dev/tty" || lower == "/dev/console") return true;
    if (lower.rfind("/dev/pts/", 0) == 0) return true;
    size_t sep = p.find_last_of("/\\");
    std::string base = (sep == std::string::npos) ? p : p.substr(sep + 1);
    size_t dot = base.find('.');
    std::string nameNoExt = (dot == std::string::npos) ? base : base.substr(0, dot);
    std::string nameLower = nameNoExt;
    for (char &c : nameLower) c = std::tolower((unsigned char)c);
    const std::string reserved[] = {"con","conin$","conout$","nul","aux","prn","com1","com2","com3","com4","com5","com6","com7","com8","com9","lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"};
    for (auto &r : reserved) if (nameLower == r) return true;
    std::string baseLower = base;
    for (char &c : baseLower) c = std::tolower((unsigned char)c);
    for (auto &r : reserved) if (baseLower == r) return true;
    return false;
}

bool shouldExcludeWin(const char* name, const char* exclude1, const char* exclude2, const char* exclude3, const char* exclude4) {
    if (!name) return false;
    const char* base = strrchr(name, '\\');
    if (!base) base = strrchr(name, '/');
    if (base) base++; else base = name;
    const char* exs[] = {exclude1, exclude2, exclude3, exclude4};
    for (int i=0;i<4;i++) if (exs[i] && exs[i][0]) {
        const char* eb = strrchr(exs[i], '\\');
        if (!eb) eb = strrchr(exs[i], '/');
        if (eb) eb++; else eb = exs[i];
        if (_stricmp(base, eb)==0 || _stricmp(name, exs[i])==0) return true;
    }
    return false;
}

void mirrorWorkDirWin(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    if (!workDir || !*workDir) return;
    DWORD attr = GetFileAttributesA(workDir);
    if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY)) return;
    char search[MAX_PATH];
    snprintf(search, sizeof(search), "%s\\*", workDir);
    WIN32_FIND_DATAA ffd;
    HANDLE hFind = FindFirstFileA(search, &ffd);
    if (hFind == INVALID_HANDLE_VALUE) return;
    do {
        if (!strcmp(ffd.cFileName, ".") || !strcmp(ffd.cFileName, "..")) continue;
        if (shouldExcludeWin(ffd.cFileName, ex1, ex2, ex3, ex4)) continue;
        char src[MAX_PATH], dst[MAX_PATH];
        snprintf(src, sizeof(src), "%s\\%s", workDir, ffd.cFileName);
        snprintf(dst, sizeof(dst), "%s\\%s", tempDir, ffd.cFileName);
        if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            CreateDirectoryA(dst, NULL);
            mirrorWorkDirWin(src, dst, ex1, ex2, ex3, ex4);
        } else {
            CopyFileA(src, dst, FALSE);
        }
    } while (FindNextFileA(hFind, &ffd));
    FindClose(hFind);
}

void ensureParentDirWin(const char* filePath) {
    char tmp[MAX_PATH];
    strncpy(tmp, filePath, sizeof(tmp)-1);
    tmp[sizeof(tmp)-1]=0;
    char* slash = strrchr(tmp, '\\');
    char* slash2 = strrchr(tmp, '/');
    char* s = slash;
    if (slash2 && (!s || slash2 > s)) s = slash2;
    if (!s) return;
    *s = 0;
    char built[MAX_PATH] = "";
    char* p = tmp;
    if (strlen(tmp)>=2 && tmp[1]==':') {
        built[0]=tmp[0]; built[1]=':'; built[2]='\\'; built[3]=0;
        p = tmp+3;
        if (*p=='\\' || *p=='/') p++;
    }
    char* token = strtok(p, "\\/");
    while (token) {
        if (strlen(built) > 0 && built[strlen(built)-1]!='\\' && built[strlen(built)-1]!='/') {
            if (strlen(built)>0) strcat(built, "\\");
        }
        strcat(built, token);
        CreateDirectoryA(built, NULL);
        token = strtok(nullptr, "\\/");
    }
}

bool fileExistsWinDirect(const char* path) {
    DWORD attr = GetFileAttributesA(path);
    return attr != INVALID_FILE_ATTRIBUTES;
}

void backupFileWinDirect(const char* path, char* backupPath, size_t sz) {
    backupPath[0]=0;
    if (!fileExistsWinDirect(path)) return;
    snprintf(backupPath, sz, "%s.dream_bak_%d", path, (int)GetCurrentProcessId());
    MoveFileA(path, backupPath);
}

void restoreFileWinDirect(const char* path, const char* backupPath) {
    if (backupPath && *backupPath) {
        DeleteFileA(path);
        MoveFileA(backupPath, path);
    } else {
        DeleteFileA(path);
    }
}



using namespace std;

// ݹɾĿ¼
void removeDir(const char* path) {
    WIN32_FIND_DATAA ffd;
    char search[MAX_PATH];
    snprintf(search, MAX_PATH, "%s\\*", path);
    HANDLE hFind = FindFirstFileA(search, &ffd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (strcmp(ffd.cFileName, ".") == 0 || strcmp(ffd.cFileName, "..") == 0) continue;
            char full[MAX_PATH];
            snprintf(full, MAX_PATH, "%s\\%s", path, ffd.cFileName);
            if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                removeDir(full);
            else
                DeleteFileA(full);
        } while (FindNextFileA(hFind, &ffd));
        FindClose(hFind);
    }
    RemoveDirectoryA(path);
}

// ʹ Windows API ļ
bool copyFileWin(const char* src, const char* dst) {
    return CopyFileA(src, dst, FALSE) != 0;
}

// ʱĿ¼
bool createTempSubDir(char* tempDir, size_t size) {
    char base[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, base)) return false;

    snprintf(tempDir, size, "%s\\dream-cpp-compiler\\tmp_%lld_%d_%d", base, (long long)time(NULL), (int)GetCurrentProcessId(), rand() % 10000);

    return CreateDirectoryA(tempDir, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}


bool writeStdinToFile(const char* filePath) {
    HANDLE hFile = CreateFileA(filePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return false;
    char buffer[4096];
    DWORD readBytes, writtenBytes;
    HANDLE hStdIn = GetStdHandle(STD_INPUT_HANDLE);
    while (ReadFile(hStdIn, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
        WriteFile(hFile, buffer, readBytes, &writtenBytes, NULL);
    }
    CloseHandle(hFile);
    return true;
}

bool dumpFileToStdout(const char* filePath) {
    HANDLE hFile = CreateFileA(filePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return false;
    char buffer[4096];
    DWORD readBytes, written;
    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    while (ReadFile(hFile, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
        WriteFile(hOut, buffer, readBytes, &written, NULL);
    }
    CloseHandle(hFile);
    return true;
}

// ʹ CreateProcess ִ
int runExe(const char* exePath, const char* workingDir) {
    STARTUPINFOA si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    char cmdLine[MAX_PATH * 2];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\"", exePath);
    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, 0, NULL, workingDir, &si, &pi))
        return -1;
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)exitCode;
}

int main(int argc, char* argv[]) {
    const char* workDir = "";
    bool workDirDirect = false;
    if (argc == 8) { workDir = argv[6]; workDirDirect = argv[7][0]=='1'; }
    else if (argc == 7) workDir = argv[6];
    else if (argc != 6) {
        printf("÷ChangeFileIO.exe <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    const char* commandArg = argv[1];
    const char* programInput = argv[2];
    const char* programOutput = argv[3];
    const char* willInput = argv[4];
    const char* willOutput = argv[5];

    bool progInputIsCon = isConsoleFile(programInput);
    bool progOutputIsCon = isConsoleFile(programOutput);
    bool willInputIsCon = isConsoleFile(willInput);
    bool willOutputIsCon = isConsoleFile(willOutput);
    if (willInputIsCon && willOutputIsCon) {
        return runExe(argv[1], nullptr);
    }
    if (workDirDirect && workDir && *workDir) {
        char directInput[MAX_PATH] = {0}, directOutput[MAX_PATH] = {0};
        char backupInput[MAX_PATH] = {0}, backupOutput[MAX_PATH] = {0};
        if (!willInputIsCon) {
            snprintf(directInput, sizeof(directInput), "%s\\%s", workDir, willInput);
            ensureParentDirWin(directInput);
            backupFileWinDirect(directInput, backupInput, sizeof(backupInput));
            if (progInputIsCon) {
                if (!writeStdinToFile(directInput)) {
                    if (backupInput[0]) MoveFileA(backupInput, directInput);
                    return -1;
                }
            } else {
                if (!CopyFileA(programInput, directInput, FALSE)) {
                    if (backupInput[0]) MoveFileA(backupInput, directInput);
                    return -1;
                }
            }
        }
        if (!willOutputIsCon) {
            snprintf(directOutput, sizeof(directOutput), "%s\\%s", workDir, willOutput);
            ensureParentDirWin(directOutput);
            backupFileWinDirect(directOutput, backupOutput, sizeof(backupOutput));
        }
        int ret = runExe(commandArg ? commandArg : argv[1], workDir);
        if (!willOutputIsCon) {
            if (progOutputIsCon) {
                HANDLE hFile = CreateFileA(directOutput, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
                if (hFile != INVALID_HANDLE_VALUE) {
                    char buffer[4096];
                    DWORD readBytes;
                    HANDLE hConsole = GetStdHandle(STD_OUTPUT_HANDLE);
                    while (ReadFile(hFile, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
                        DWORD written;
                        WriteConsoleA(hConsole, buffer, readBytes, &written, NULL);
                    }
                    CloseHandle(hFile);
                }
                DeleteFileA(directOutput);
                if (backupOutput[0]) MoveFileA(backupOutput, directOutput);
            } else {
                CopyFileA(directOutput, programOutput, FALSE);
                DeleteFileA(directOutput);
                if (backupOutput[0]) MoveFileA(backupOutput, directOutput);
            }
        }
        if (!willInputIsCon) {
            if (backupInput[0]) { DeleteFileA(directInput); MoveFileA(backupInput, directInput); }
            else DeleteFileA(directInput);
        }
        return ret;
    }
    char tempDir[MAX_PATH], tempInput[MAX_PATH] = {0}, tempOutput[MAX_PATH] = {0}, tempExe[MAX_PATH];
    bool needTemp = !willInputIsCon || !willOutputIsCon;
    if (needTemp) {
        if (!createTempSubDir(tempDir, sizeof(tempDir))) {
            printf("无法创建临时目录\n");
            return -1;
        }
        if (!willInputIsCon) snprintf(tempInput, MAX_PATH, "%s\%s", tempDir, willInput);
        if (!willOutputIsCon) snprintf(tempOutput, MAX_PATH, "%s\%s", tempDir, willOutput);
    } else {
        tempDir[0] = 0;
    }
    if (needTemp && workDir && *workDir) {
        mirrorWorkDirWin(workDir, tempDir, argv[2], argv[3], argv[4], argv[5]);
    }
    if (!willInputIsCon) {
        if (progInputIsCon) {
            if (!writeStdinToFile(tempInput)) {
                printf("无法从控制台读取输入到临时目录\n");
                if (needTemp) removeDir(tempDir);
                return -1;
            }
        } else {
            if (!copyFileWin(programInput, tempInput)) {
                printf("无法复制输入文件到临时目录\n");
                if (needTemp) removeDir(tempDir);
                return -1;
            }
        }
    }
    int ret = runExe(commandArg, needTemp ? tempDir : nullptr);
    if (!willOutputIsCon) {
        if (progOutputIsCon) {
            dumpFileToStdout(tempOutput);
        } else {
            copyFileWin(tempOutput, programOutput);
        }
    }
    if (needTemp) removeDir(tempDir);
    return ret;
}
