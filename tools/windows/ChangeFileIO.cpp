#include <windows.h>
#include <cstdio>
#include <ctime>

using namespace std;

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

// 使用 Windows API 拷贝文件
bool copyFileWin(const char* src, const char* dst) {
    return CopyFileA(src, dst, FALSE) != 0;
}

// 创建临时目录
bool createTempSubDir(char* tempDir, size_t size) {
    char base[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, base)) return false;

    snprintf(tempDir, size, "%s\\dream-cpp-compiler\\tmp_%lld", base, (long long)time(NULL));

    return CreateDirectoryA(tempDir, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
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
    if (argc != 6) {
        printf("用法：ChangeFileIO.exe <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    const char* commandArg = argv[1];
    const char* programInput = argv[2];
    const char* programOutput = argv[3];
    const char* willInput = argv[4];
    const char* willOutput = argv[5];

    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH], tempExe[MAX_PATH];

    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    snprintf(tempInput, MAX_PATH, "%s\\%s", tempDir, willInput);
    snprintf(tempOutput, MAX_PATH, "%s\\%s", tempDir, willOutput);

    // 将 WillinputFile 复制到临时目录 programInput
    if (!copyFileWin(programInput, tempInput)) {
        printf("无法复制输入文件到临时目录\n");
        removeDir(tempDir);
        return -1;
    }

    // 执行临时 exe 并收集信息
    int ret = runExe(commandArg, tempDir);

    // 将输出文件复制回 WilloutputFile
    copyFileWin(tempOutput, programOutput);

    // 删除临时目录
    removeDir(tempDir);

    return ret;
}
