#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <string.h>
#include <errno.h>

// 计算两个timeval的时间差（微秒）
long long timeval_diff(const struct timeval* start, const struct timeval* end) {
    return (end->tv_sec - start->tv_sec) * 1000000LL +
           (end->tv_usec - start->tv_usec);
}

int main(int argc, char* argv[]) {
    if (argc != 2) {
        printf("用法：ConsoleInfo <command>\n");
        return -1;
    }

    struct timeval start_time, end_time;
    pid_t child_pid;
    int status;
    struct rusage usage;

    // 记录开始时间（总执行时间计时起点）
    if (gettimeofday(&start_time, NULL) == -1) {
        perror("获取开始时间失败");
        return -1;
    }

    // 创建子进程执行命令（替代Windows的CreateProcessA）
    child_pid = fork();
    if (child_pid == -1) {
        perror("创建进程失败");
        return -1;
    }

    if (child_pid == 0) {
        // 子进程：执行命令（通过shell解析命令字符串）
        execl("/bin/sh", "sh", "-c", argv[1], (char*)NULL);
        // 如果execl返回，说明执行失败
        perror("执行命令失败");
        exit(EXIT_FAILURE);
    }

    // 等待子进程结束（替代Windows的WaitForSingleObject）
    if (waitpid(child_pid, &status, 0) == -1) {
        perror("等待进程结束失败");
        return -1;
    }

    // 记录结束时间
    if (gettimeofday(&end_time, NULL) == -1) {
        perror("获取结束时间失败");
        return -1;
    }

    // 获取进程资源使用信息（替代Windows的GetProcessMemoryInfo和GetProcessTimes）
    if (getrusage(RUSAGE_CHILDREN, &usage) == -1) {
        perror("获取进程资源信息失败");
        return -1;
    }

    // 计算总执行时间（微秒）
    long long executionTime = timeval_diff(&start_time, &end_time);

    // 内存使用（峰值工作集大小，单位：KB）
    // Linux的ru_maxrss在不同架构下单位可能不同（这里按KB处理）
    long peakMemory = usage.ru_maxrss;

    // 计算CPU时间（微秒）
    long long kernelTime = (usage.ru_stime.tv_sec * 1000000LL) + usage.ru_stime.tv_usec;  // 内核态时间
    long long userTime = (usage.ru_utime.tv_sec * 1000000LL) + usage.ru_utime.tv_usec;      // 用户态时间

    // 获取程序退出代码（替代Windows的GetExitCodeProcess）
    int returnValue;
    if (WIFEXITED(status)) {
        returnValue = WEXITSTATUS(status);  // 正常退出的返回值
    } else if (WIFSIGNALED(status)) {
        returnValue = 128 + WTERMSIG(status);  // 被信号终止的情况
    } else {
        returnValue = -1;  // 其他异常情况
    }

    // 输出结果（保持与原Windows版本相同的格式）
    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存使用：%ld KB", peakMemory);
    printf("\nCPU内核时间：%.3f 秒", kernelTime / 1000000.0);
    printf("\nCPU用户时间：%.3f 秒", userTime / 1000000.0);
    printf("\n总CPU时间：%.3f 秒", (kernelTime + userTime) / 1000000.0);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return 0;
}
