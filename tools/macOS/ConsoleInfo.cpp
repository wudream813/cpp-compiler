#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <time.h>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        printf("用法：ConsoleInfo <command>\n");
        return -1;
    }

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    pid_t pid = fork();
    if (pid < 0) {
        perror("Fork failed");
        return -1;
    }

    if (pid == 0) {
        // Child process
        // 为了支持带参数的命令，使用 /bin/sh -c
        execl("/bin/sh", "sh", "-c", argv[1], NULL);
        exit(127);
    }

    // Parent process
    int status;
    struct rusage usage;
    // wait4 等待进程结束并获取资源使用情况
    if (wait4(pid, &status, 0, &usage) == -1) {
        perror("wait4 failed");
        return -1;
    }

    clock_gettime(CLOCK_MONOTONIC, &end);

    // 计算总时间 (毫秒)
    long long executionTime = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;

    int returnValue = 0;
    if (WIFEXITED(status)) {
        returnValue = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        returnValue = 128 + WTERMSIG(status);
    }

    // macOS ru_maxrss 单位是 bytes (Linux 是 KB)
    // 我们统一转为 KB
    long memoryKB = usage.ru_maxrss / 1024;

    double userTime = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1000000.0;
    double sysTime = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1000000.0;

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存峰值：%ld KB", memoryKB);
    printf("\nCPU内核(System)时间：%.3f 秒", sysTime);
    printf("\nCPU用户(User)时间：%.3f 秒", userTime);
    printf("\n总CPU时间：%.3f 秒", userTime + sysTime);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------\n");

    return 0;
}
