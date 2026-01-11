#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        printf("用法：ConsoleInfo <command>\n");
        return -1;
    }

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    pid_t pid = fork();
    if (pid < 0) return -1;

    if (pid == 0) {
        char* args[] = { argv[1], NULL };
        execvp(argv[1], args);
        _exit(127);
    }

    int status;
    struct rusage usage;
    waitpid(pid, &status, 0);
    getrusage(RUSAGE_CHILDREN, &usage);
    clock_gettime(CLOCK_MONOTONIC, &end);

    long long executionTimeMs = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
    double userTime = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6;
    double sysTime = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
    long memoryPeakKB = usage.ru_maxrss;

    int returnValue = WIFEXITED(status) ? WEXITSTATUS(status) : (128 + WTERMSIG(status));

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTimeMs / 1000, executionTimeMs % 1000);
    printf("\n内存峰值：%ld KB", memoryPeakKB);
    printf("\nCPU内核时间：%.3f 秒", sysTime);
    printf("\nCPU用户时间：%.3f 秒", userTime);
    printf("\n总CPU时间：%.3f 秒", sysTime + userTime);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return 0;
}
