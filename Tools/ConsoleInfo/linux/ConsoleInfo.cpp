#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <errno.h>

long long now_us() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
}

int main(int argc, char* argv[]) {
	if (argc < 2) {
		printf("用法：ConsoleInfo <command> [args...]\n");
		return -1;
	}

	long long start_us = now_us();

	pid_t pid = fork();
	if (pid < 0) {
		perror("fork 失败");
		return -1;
	}

	if (pid == 0) {
		// 子进程：执行命令
		execvp(argv[1], &argv[1]);
		perror("execvp 失败");
		exit(127);
	}

	// 父进程：等待子进程结束
	int status;
	struct rusage usage;
	if (wait4(pid, &status, 0, &usage) < 0) {
		perror("wait4 失败");
		return -1;
	}

	long long end_us = now_us();
	long long exec_time_us = end_us - start_us;

	// 获取 CPU 时间
	double user_time = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6;
	double sys_time = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;

	// 内存峰值（KB）
	long mem_kb = usage.ru_maxrss; // Linux 下 ru_maxrss 单位就是 KB

	// 程序退出码
	int returnValue = -1;
	if (WIFEXITED(status)) {
		returnValue = WEXITSTATUS(status);
	}

	// 输出结果
	printf("\n-----------------------------------------------");
	printf("\n总执行时间：%lld.%03lld ms", exec_time_us / 1000, exec_time_us % 1000);
	printf("\n内存使用：%ld KB", mem_kb);
	printf("\nCPU内核时间：%.3f 秒", sys_time);
	printf("\nCPU用户时间：%.3f 秒", user_time);
	printf("\n总CPU时间：%.3f 秒", sys_time + user_time);
	printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
	printf("\n-----------------------------------------------\n");

	return 0;
}
