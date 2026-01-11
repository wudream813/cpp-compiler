#include <Windows.h>
#include <cstdio>
#include <ctime>

// 自定义 PROCESS_MEMORY_COUNTERS 结构
typedef struct _PROCESS_MEMORY_COUNTERS {
    DWORD cb;
    DWORD PageFaultCount;
    SIZE_T PeakWorkingSetSize;
    SIZE_T WorkingSetSize;
    SIZE_T QuotaPeakPagedPoolUsage;
    SIZE_T QuotaPagedPoolUsage;
    SIZE_T QuotaPeakNonPagedPoolUsage;
    SIZE_T QuotaNonPagedPoolUsage;
    SIZE_T PagefileUsage;
    SIZE_T PeakPagefileUsage;
} PROCESS_MEMORY_COUNTERS;

// 函数指针类型
typedef BOOL(WINAPI *PFN_GetProcessMemoryInfo)(HANDLE, PROCESS_MEMORY_COUNTERS*, DWORD);

// 创建临时目录
bool createTempSubDir(char* tempDir, size_t size) {
    char base[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, base)) return false;

    snprintf(tempDir, size, "%s\\dream-cpp-compiler\\tmp_%lld", base, (long long)time(NULL));

    return CreateDirectoryA(tempDir, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

// 递归删除目录
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

// 将 stdin 写入文件
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

// 使用 CreateProcess 执行命令
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
    if (argc != 4) {
        printf("用法：ConsoleInfoUnFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }

    const char *inputFile = argv[2];
    const char *outputFile = argv[3];

    char tempDir[MAX_PATH];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    char tempInput[MAX_PATH], tempOutput[MAX_PATH];
    snprintf(tempInput, MAX_PATH, "%s\\%s", tempDir, inputFile);
    snprintf(tempOutput, MAX_PATH, "%s\\%s", tempDir, outputFile);

    if (!writeStdinToFile(tempInput)) {
        printf("无法写入临时输入文件\n");
        removeDir(tempDir);
        return -1;
    }

    // 执行命令
    int ret = runExe(argv[1], tempDir);

    HANDLE hFile = CreateFileA(tempOutput, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        printf("错误：无法打开输出文件");
    } else {
        char buffer[4096];
        DWORD readBytes;
        HANDLE hConsole = GetStdHandle(STD_OUTPUT_HANDLE);
        while (ReadFile(hFile, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
            DWORD written;
            WriteConsoleA(hConsole, buffer, readBytes, &written, NULL);
        }

        CloseHandle(hFile);
    }
    // 删除临时目录
    removeDir(tempDir);

    return ret;
}
