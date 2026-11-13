#include <windows.h>
#include <cstdio>
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

    snprintf(tempDir, size, "%s\\dream-cpp-compiler\\tmp_%lld", base, (long long)time(NULL));

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
    if (argc != 6) {
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
        return runExe(commandArg, nullptr);
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
