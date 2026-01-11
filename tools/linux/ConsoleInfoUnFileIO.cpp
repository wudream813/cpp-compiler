#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <limits.h>

void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (d) {
        struct dirent* p;
        while ((p = readdir(d))) {
            if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
            char buf[PATH_MAX];
            snprintf(buf, PATH_MAX, "%s/%s", path, p->d_name);
            struct stat statbuf;
            if (!stat(buf, &statbuf)) {
                if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
                else unlink(buf);
            }
        }
        closedir(d);
    }
    rmdir(path);
}

bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld", base, (long long)time(NULL));
    return mkdir(tempDir, 0777) == 0;
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
        char* args[] = { (char*)exePath, NULL };
        execvp(exePath, args);
        _exit(127);
    }

    int status;
    struct rusage usage;
    waitpid(pid, &status, 0);
    getrusage(RUSAGE_CHILDREN, &usage);
    clock_gettime(CLOCK_MONOTONIC, &end);

    int fd = open(outputPath, O_RDONLY);
    if (fd < 0) {
        printf("错误：无法打开输出文件");
    } else {
        char buffer[4096];
        ssize_t bytes;
        while ((bytes = read(fd, buffer, sizeof(buffer))) > 0) {
            write(STDOUT_FILENO, buffer, bytes);
        }
        close(fd);
    }

    long long executionTimeMs = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
    double userTime = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6;
    double sysTime = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
    long memoryPeakKB = usage.ru_maxrss;
    int returnValue = WIFEXITED(status) ? WEXITSTATUS(status) : (128 + WTERMSIG(status));

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTimeMs / 1000, executionTimeMs % 1000);
    printf("\n内存使用：%ld KB", memoryPeakKB);
    printf("\nCPU内核时间：%.3f 秒", sysTime);
    printf("\nCPU用户时间：%.3f 秒", userTime);
    printf("\n总CPU时间：%.3f 秒", sysTime + userTime);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return returnValue;
}

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：ConsoleInfoUnFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }

    char tempDir[PATH_MAX], tempInput[PATH_MAX], tempOutput[PATH_MAX];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    snprintf(tempInput, PATH_MAX, "%s/%s", tempDir, argv[2]);
    snprintf(tempOutput, PATH_MAX, "%s/%s", tempDir, argv[3]);

    if (!writeStdinToFile(tempInput)) {
        printf("无法写入临时输入文件\n");
        removeDir(tempDir);
        return -1;
    }

    int ret = runTargetExe(argv[1], tempDir, tempOutput);
    removeDir(tempDir);
    return ret;
}
