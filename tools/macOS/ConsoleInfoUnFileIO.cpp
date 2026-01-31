#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <ctime>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <limits.h>

#ifndef MAX_PATH
#define MAX_PATH PATH_MAX
#endif

using namespace std;

void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (!d) { rmdir(path); return; }
    struct dirent* p;
    while ((p = readdir(d))) {
        if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
        char buf[MAX_PATH];
        snprintf(buf, sizeof(buf), "%s/%s", path, p->d_name);
        struct stat statbuf;
        if (!stat(buf, &statbuf)) {
            if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
            else unlink(buf);
        }
    }
    closedir(d);
    rmdir(path);
}

bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";
    string baseStr = base;
    if (baseStr.back() == '/') baseStr.pop_back();

    char parentDir[MAX_PATH];
    snprintf(parentDir, MAX_PATH, "%s/dream-cpp-compiler", baseStr.c_str());
    mkdir(parentDir, 0755);

    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld", baseStr.c_str(), (long long)time(NULL));
    return mkdir(tempDir, 0755) == 0 || errno == EEXIST;
}

bool writeStdinToFile(const char* filePath) {
    int fd = open(filePath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return false;

    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
        write(fd, buffer, bytes);
    }
    close(fd);
    return true;
}

int runTargetExe(const char* exePath, const char* workingDir, const char* outputPath) {
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    pid_t pid = fork();
    if (pid == 0) {
        if (workingDir) chdir(workingDir);
        execl("/bin/sh", "sh", "-c", exePath, NULL);
        exit(127);
    }

    int status;
    struct rusage usage;
    wait4(pid, &status, 0, &usage);
    clock_gettime(CLOCK_MONOTONIC, &end);

    // 将结果从 outputPath 读出并打印到 stdout
    int fdOut = open(outputPath, O_RDONLY);
    if (fdOut >= 0) {
        char buffer[4096];
        ssize_t bytes;
        while ((bytes = read(fdOut, buffer, sizeof(buffer))) > 0) {
            write(STDOUT_FILENO, buffer, bytes);
        }
        close(fdOut);
    }

    long long executionTime = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
    int returnValue = WIFEXITED(status) ? WEXITSTATUS(status) : (128 + WTERMSIG(status));

    long memoryKB = usage.ru_maxrss / 1024;
    double userTime = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1000000.0;
    double sysTime = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1000000.0;

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存使用：%ld KB", memoryKB);
    printf("\nCPU内核时间：%.3f 秒", sysTime);
    printf("\nCPU用户时间：%.3f 秒", userTime);
    printf("\n总CPU时间：%.3f 秒", userTime + sysTime);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------\n");

    return returnValue;
}

int main(int argc, char* argv[]) {
    if (argc != 4) return -1;

    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) return -1;

    snprintf(tempInput, MAX_PATH, "%s/%s", tempDir, argv[2]);
    snprintf(tempOutput, MAX_PATH, "%s/%s", tempDir, argv[3]);

    if (!writeStdinToFile(tempInput)) {
        removeDir(tempDir);
        return -1;
    }

    int ret = runTargetExe(argv[1], tempDir, tempOutput);
    removeDir(tempDir);
    return ret;
}
